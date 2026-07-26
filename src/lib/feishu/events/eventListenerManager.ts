import * as lark from '@larksuiteoapi/node-sdk';
import { logFeishuMonitor } from '../common/monitor';
import {
  cleanupStaleIncompleteFeishuIntegrations,
  cleanupSupersededInactiveFeishuIntegrations,
  getFeishuIntegrationCheckStatus,
  getFeishuIntegrationContextById,
  listActiveFeishuIntegrationContextsWithBase,
  upsertFeishuIntegrationCheckStatus,
  updateUserFeishuIntegration,
  writeAuditLog,
} from '../integration/integrationStore';
import {
  FeishuAuthorizationError,
  getValidIntegrationUserAuthorization,
} from '../integration/tokenService';
import { isFeishuIntegrationActive } from '../integration/integrationActivationService';
import { enqueueFeishuEvent } from '../pipeline/meetingPipelineProcessor';
import { FEISHU_REQUIRED_USER_EVENTS } from '../integration/integrationConstants';

export type ListenerState = 'stopped' | 'starting' | 'running' | 'reconnecting' | 'error';

export interface ListenerInfo {
  integrationId: string;
  state: ListenerState;
  lastError: string | null;
  startedAt: Date | null;
  readyAt: Date | null;
  reconnectCount: number;
  client: lark.WSClient | null;
}

type ListenerStartFailureContext = {
  reasonCode: string;
  blockedGate: string;
  message: string;
  errorName?: string;
};

class ListenerPrerequisiteError extends Error {
  constructor(
    public readonly reasonCode: string,
    public readonly blockedGate: string,
    message: string
  ) {
    super(message);
    this.name = 'ListenerPrerequisiteError';
  }
}

const listeners = new Map<string, ListenerInfo>();
const EVENT_TYPE = FEISHU_REQUIRED_USER_EVENTS[0];
const READY_TIMEOUT_MS = 20_000;
const INACTIVE_LISTENER_SWEEP_INTERVAL_MS = 10_000;
const INTEGRATION_CLEANUP_SWEEP_INTERVAL_MS = 10 * 60_000;
const STALE_INCOMPLETE_INTEGRATION_TTL_MS = 6 * 60 * 60_000;
const SUPERSEDED_INACTIVE_INTEGRATION_TTL_MS = 30 * 60_000;
let inactiveListenerSweepTimer: ReturnType<typeof setInterval> | null = null;
let integrationCleanupSweepTimer: ReturnType<typeof setInterval> | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function getListenerStartFailureContext(error: unknown): ListenerStartFailureContext {
  if (error instanceof ListenerPrerequisiteError) {
    return {
      reasonCode: error.reasonCode,
      blockedGate: error.blockedGate,
      message: error.message,
      errorName: error.name,
    };
  }

  if (error instanceof FeishuAuthorizationError) {
    return {
      reasonCode: `oauth_${error.code}`,
      blockedGate: 'oauth',
      message: error.message,
      errorName: error.name,
    };
  }

  if (error instanceof Error) {
    return {
      reasonCode: 'listener_connection_failed',
      blockedGate: 'event_listener',
      message: error.message,
      errorName: error.name,
    };
  }

  return {
    reasonCode: 'listener_unknown_error',
    blockedGate: 'event_listener',
    message: String(error),
  };
}

async function enqueueSdkEvent(integrationId: string, rawEvent: unknown): Promise<void> {
  const integration = await getFeishuIntegrationContextById(integrationId);
  if (!integration) {
    logFeishuMonitor('warn', 'event_listener_integration_not_found', { integrationId });
    return;
  }

  const event = asRecord(rawEvent);
  const eventId = typeof event.event_id === 'string' ? event.event_id : undefined;
  const eventType =
    typeof event.event_type === 'string' ? event.event_type : EVENT_TYPE;
  const createTime =
    typeof event.create_time === 'string' || typeof event.create_time === 'number'
      ? String(event.create_time)
      : undefined;

  await enqueueFeishuEvent(
    {
      schema: typeof event.schema === 'string' ? event.schema : '2.0',
      type: eventType,
      header: {
        event_id: eventId,
        event_type: eventType,
        create_time: createTime,
      },
      event,
    },
    integration
  );
}

async function assertListenerPrerequisites(integrationId: string) {
  const integration = await getFeishuIntegrationContextById(integrationId);
  if (!integration) {
    throw new ListenerPrerequisiteError(
      'integration_not_found',
      'integration',
      '未找到飞书集成配置。'
    );
  }
    if (!(await isFeishuIntegrationActive(integrationId))) {
      throw new ListenerPrerequisiteError(
        'integration_inactive',
        'activation',
        '当前飞书集成不是当前生效版本，不能启动事件长连接。'
      );
    }
  if (!integration.selectedOrgTargetId) {
    throw new ListenerPrerequisiteError(
      'organization_not_selected',
      'organization',
      '尚未选择组织，不能启动事件长连接。'
    );
  }

  await getValidIntegrationUserAuthorization(integration);
  const checks = await getFeishuIntegrationCheckStatus(integrationId);
  if (checks?.appCredentialStatus !== 'success') {
    throw new ListenerPrerequisiteError(
      checks?.appCredentialStatus === 'failed' ? 'app_credential_failed' : 'app_credential_pending',
      'app_credential',
      '飞书应用凭证尚未通过校验，不能启动事件长连接。'
    );
  }
  if (checks?.baseStatus !== 'success') {
    throw new ListenerPrerequisiteError(
      checks?.baseStatus === 'failed' ? 'base_access_failed' : 'base_access_pending',
      'base',
      '目标多维表格尚未通过可访问校验，不能启动事件长连接。'
    );
  }
  if (checks?.permissionStatus !== 'success') {
    throw new ListenerPrerequisiteError(
      checks?.permissionStatus === 'failed' ? 'permission_scope_failed' : 'permission_scope_pending',
      'permission',
      '飞书用户权限尚未通过校验，不能启动事件长连接。'
    );
  }
  if (checks?.minuteSubscriptionStatus !== 'success') {
    throw new ListenerPrerequisiteError(
      checks?.minuteSubscriptionStatus === 'failed'
        ? 'minute_change_subscription_failed'
        : 'minute_change_subscription_pending',
      'minute_subscription',
      '当前授权用户尚未完成妙记生成事件订阅，不能启动事件长连接。'
    );
  }
  return integration;
}

async function markListenerReady(integrationId: string): Promise<void> {
  const listener = listeners.get(integrationId);
  const integration = await getFeishuIntegrationContextById(integrationId);
  if (!listener || !integration) return;

  listener.state = 'running';
  listener.readyAt = new Date();
  listener.lastError = null;
  const currentChecks = await getFeishuIntegrationCheckStatus(integrationId);
  await upsertFeishuIntegrationCheckStatus({
    integrationId,
    eventSubscriptionStatus: 'success',
    lastErrorType: null,
    lastErrorMessage: null,
    details: {
      ...(currentChecks?.details || {}),
      eventSubscription: {
        ok: true,
        provider: 'node_sdk_ws',
        eventKey: EVENT_TYPE,
        readyAt: listener.readyAt.toISOString(),
      },
    },
  });
  await updateUserFeishuIntegration(integration.userId, integrationId, {
    status: 'success',
    setupStep: 'event_listener',
    initializedAt: new Date(),
  });
  await writeAuditLog({
    userId: integration.userId,
    integrationId,
    action: 'event_listener.connected',
    result: 'success',
    summary: '飞书 SDK 事件长连接已建立',
    metadata: { eventKey: EVENT_TYPE, provider: 'node_sdk_ws' },
  });
  logFeishuMonitor('info', 'event_listener_ready', {
    integrationId,
    eventType: EVENT_TYPE,
    provider: 'node_sdk_ws',
    readyAt: listener.readyAt.toISOString(),
  });
}

async function markListenerFailed(integrationId: string, error: Error): Promise<void> {
  const listener = listeners.get(integrationId);
  if (listener) {
    listener.state = 'error';
    listener.lastError = error.message;
    listener.readyAt = null;
  }
  const [currentChecks, integration] = await Promise.all([
    getFeishuIntegrationCheckStatus(integrationId),
    getFeishuIntegrationContextById(integrationId),
  ]);
  await upsertFeishuIntegrationCheckStatus({
    integrationId,
    eventSubscriptionStatus: 'failed',
    lastErrorType: error.name || 'FeishuWsConnectionError',
    lastErrorMessage: error.message,
    details: {
      ...(currentChecks?.details || {}),
      eventSubscription: {
        ok: false,
        provider: 'node_sdk_ws',
        eventKey: EVENT_TYPE,
      },
    },
  });
  logFeishuMonitor('error', 'event_listener_failed', {
    integrationId,
    eventType: EVENT_TYPE,
    provider: 'node_sdk_ws',
    ...getListenerStartFailureContext(error),
  });
  if (integration) {
    try {
      await writeAuditLog({
        userId: integration.userId,
        integrationId,
        action: 'event_listener.connected',
        result: 'failed',
        summary: '飞书 SDK 事件长连接建立或运行失败',
        metadata: {
          eventKey: EVENT_TYPE,
          provider: 'node_sdk_ws',
          errorType: error.name,
          errorMessage: error.message,
        },
      });
    } catch (auditError) {
      logFeishuMonitor('error', 'event_listener_failure_audit_failed', {
        integrationId,
        message: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }
  }
}

function persistListenerFailure(integrationId: string, error: Error): void {
  void markListenerFailed(integrationId, error).catch((persistenceError) => {
    logFeishuMonitor('error', 'event_listener_failure_persist_failed', {
      integrationId,
      message: persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
    });
  });
}

async function startListenerForIntegration(integrationId: string): Promise<ListenerInfo> {
  const existing = listeners.get(integrationId);
  if (existing?.state === 'running' && existing.client) {
    return existing;
  }

  const integration = await assertListenerPrerequisites(integrationId);
  if (existing?.client) {
    existing.client.close({ force: true });
  }

  const listener: ListenerInfo = {
    integrationId,
    state: 'starting',
    lastError: null,
    startedAt: new Date(),
    readyAt: null,
    reconnectCount: existing?.reconnectCount || 0,
    client: null,
  };
  listeners.set(integrationId, listener);

  let resolveReady: ((value: ListenerInfo) => void) | null = null;
  let rejectReady: ((reason: Error) => void) | null = null;
  let settled = false;
  const readyPromise = new Promise<ListenerInfo>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const client = new lark.WSClient({
    appId: integration.appId,
    appSecret: integration.secrets.appSecret,
    domain: lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.error,
    autoReconnect: true,
    source: 'teaming-meeting-analysis',
    handshakeTimeoutMs: READY_TIMEOUT_MS,
    wsConfig: { pingTimeout: 15 },
    onReady: () => {
      void markListenerReady(integrationId)
        .then(() => {
          if (!settled) {
            settled = true;
            resolveReady?.(listener);
          }
        })
        .catch((error) => {
          if (!settled) {
            settled = true;
            rejectReady?.(error instanceof Error ? error : new Error(String(error)));
          }
        });
    },
    onError: (error) => {
      persistListenerFailure(integrationId, error);
      if (!settled) {
        settled = true;
        rejectReady?.(error);
      }
    },
    onReconnecting: () => {
      const current = listeners.get(integrationId);
      if (current) {
        current.state = 'reconnecting';
        current.reconnectCount += 1;
      }
      void getFeishuIntegrationCheckStatus(integrationId)
        .then((checks) =>
          upsertFeishuIntegrationCheckStatus({
            integrationId,
            eventSubscriptionStatus: 'pending',
            details: {
              ...(checks?.details || {}),
              eventSubscription: {
                ok: false,
                reconnecting: true,
                eventKey: EVENT_TYPE,
              },
            },
          })
        )
        .catch((error) => {
          logFeishuMonitor('error', 'event_listener_reconnecting_status_failed', {
            integrationId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    },
    onReconnected: () => {
      void markListenerReady(integrationId);
    },
  });
  listener.client = client;

  const dispatcher = new lark.EventDispatcher({
    loggerLevel: lark.LoggerLevel.error,
  }).register<Record<string, (data: unknown) => Promise<void>>>({
    [EVENT_TYPE]: async (data: unknown) => {
      await enqueueSdkEvent(integrationId, data);
    },
  });

  logFeishuMonitor('info', 'event_listener_starting', {
    integrationId,
    eventType: EVENT_TYPE,
    provider: 'node_sdk_ws',
  });
  void client.start({ eventDispatcher: dispatcher }).catch((error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    persistListenerFailure(integrationId, normalized);
    if (!settled) {
      settled = true;
      rejectReady?.(normalized);
    }
  });

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    client.close({ force: true });
    const timeoutError = new Error('等待飞书事件长连接建立超时，请稍后重试。');
    persistListenerFailure(integrationId, timeoutError);
    rejectReady?.(timeoutError);
  }, READY_TIMEOUT_MS + 1_000);

  return readyPromise.finally(() => clearTimeout(timer));
}

export function stopListener(integrationId: string): void {
  const listener = listeners.get(integrationId);
  if (!listener) return;
  listener.client?.close({ force: true });
  listener.client = null;
  listener.state = 'stopped';
  listener.readyAt = null;
  logFeishuMonitor('info', 'event_listener_stopped', {
    integrationId,
    eventType: EVENT_TYPE,
  });
}

export async function startListener(integrationId: string): Promise<ListenerInfo> {
  return startListenerForIntegration(integrationId);
}

export async function startAllListeners(): Promise<void> {
  try {
      const integrations = await listActiveFeishuIntegrationContextsWithBase();
    logFeishuMonitor('info', 'event_listener_start_all', {
      count: integrations.length,
      provider: 'node_sdk_ws',
    });
    for (const integration of integrations) {
      void startListenerForIntegration(integration.id).catch((error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
      void upsertFeishuIntegrationCheckStatus({
          integrationId: integration.id,
          ...(normalized instanceof FeishuAuthorizationError ? { oauthStatus: 'failed' } : {}),
          eventSubscriptionStatus: 'pending',
          lastErrorType: normalized.name,
          lastErrorMessage: normalized.message,
          details: {
            eventSubscription: {
              ok: false,
              pending: true,
              provider: 'node_sdk_ws',
              eventKey: EVENT_TYPE,
              reason: 'startup_prerequisite_failed',
              ...getListenerStartFailureContext(normalized),
            },
          },
        });
        void updateUserFeishuIntegration(integration.userId, integration.id, {
          status: 'draft',
          initializedAt: null,
        });
        logFeishuMonitor('warn', 'event_listener_start_skipped', {
          integrationId: integration.id,
          ...getListenerStartFailureContext(normalized),
        });
      });
    }
  } catch (error) {
    logFeishuMonitor('error', 'event_listener_start_all_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function sweepInactiveListeners(): Promise<void> {
  const activeIntegrations = await listActiveFeishuIntegrationContextsWithBase();
  const activeIntegrationIds = new Set(activeIntegrations.map((integration) => integration.id));
  const runningListeners = [...listeners.values()].filter((listener) => listener.state !== 'stopped');
  let stoppedCount = 0;

  runningListeners.forEach((listener) => {
    if (activeIntegrationIds.has(listener.integrationId)) return;
    stopListener(listener.integrationId);
    stoppedCount += 1;
  });

  if (stoppedCount > 0) {
    logFeishuMonitor('info', 'inactive_listener_sweep_completed', {
      checkedCount: runningListeners.length,
      activeCount: activeIntegrationIds.size,
      stoppedCount,
    });
  }
}

async function sweepStaleFeishuIntegrations(): Promise<void> {
  const now = Date.now();
  const [staleIncomplete, staleSuperseded] = await Promise.all([
    cleanupStaleIncompleteFeishuIntegrations({
      cutoff: new Date(now - STALE_INCOMPLETE_INTEGRATION_TTL_MS),
    }),
    cleanupSupersededInactiveFeishuIntegrations({
      cutoff: new Date(now - SUPERSEDED_INACTIVE_INTEGRATION_TTL_MS),
    }),
  ]);

  const cleanupCandidates = [...staleIncomplete, ...staleSuperseded];
  if (cleanupCandidates.length === 0) {
    return;
  }
  const uniqueCleanupCandidates = Array.from(
    new Map(cleanupCandidates.map((candidate) => [candidate.integrationId, candidate])).values()
  );

  let stoppedListenerCount = 0;
  uniqueCleanupCandidates.forEach((candidate) => {
    const listener = listeners.get(candidate.integrationId);
    if (!listener || listener.state === 'stopped') return;
    stopListener(candidate.integrationId);
    stoppedListenerCount += 1;
  });

  logFeishuMonitor('info', 'feishu_integration_cleanup_completed', {
    staleIncompleteCount: staleIncomplete.length,
    supersededInactiveCount: staleSuperseded.length,
    cleanedCount: uniqueCleanupCandidates.length,
    stoppedListenerCount,
    staleIncompleteTtlMs: STALE_INCOMPLETE_INTEGRATION_TTL_MS,
    supersededInactiveTtlMs: SUPERSEDED_INACTIVE_INTEGRATION_TTL_MS,
    cleanedIntegrationIds: uniqueCleanupCandidates.map((candidate) => candidate.integrationId),
  });
}

export function startInactiveListenerSweeper(): void {
  if (inactiveListenerSweepTimer) return;
  inactiveListenerSweepTimer = setInterval(() => {
    void sweepInactiveListeners().catch((error) => {
      logFeishuMonitor('error', 'inactive_listener_sweep_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, INACTIVE_LISTENER_SWEEP_INTERVAL_MS);
  inactiveListenerSweepTimer.unref?.();
  logFeishuMonitor('info', 'inactive_listener_sweeper_started', {
    intervalMs: INACTIVE_LISTENER_SWEEP_INTERVAL_MS,
  });
}

export function startFeishuIntegrationCleanupSweeper(): void {
  if (integrationCleanupSweepTimer) return;
  integrationCleanupSweepTimer = setInterval(() => {
    void sweepStaleFeishuIntegrations().catch((error) => {
      logFeishuMonitor('error', 'feishu_integration_cleanup_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, INTEGRATION_CLEANUP_SWEEP_INTERVAL_MS);
  integrationCleanupSweepTimer.unref?.();
  logFeishuMonitor('info', 'feishu_integration_cleanup_sweeper_started', {
    intervalMs: INTEGRATION_CLEANUP_SWEEP_INTERVAL_MS,
    staleIncompleteTtlMs: STALE_INCOMPLETE_INTEGRATION_TTL_MS,
    supersededInactiveTtlMs: SUPERSEDED_INACTIVE_INTEGRATION_TTL_MS,
  });
}
export function getListenerStatus(integrationId: string): ListenerInfo | undefined {
  return listeners.get(integrationId);
}

export function getAllListenersStatus(): ListenerInfo[] {
  return Array.from(listeners.values());
}
