import { spawn, ChildProcess } from 'child_process';
import { logFeishuMonitor } from '../common/monitor';
import { getFeishuIntegrationContextById } from '../integration/integrationStore';
import { enqueueFeishuEvent } from '../pipeline/meetingPipelineProcessor';
import { getDb } from '@/lib/db/client';
import { feishuIntegrations } from '@/lib/db/schema';
import { eq, and, isNull, not } from 'drizzle-orm';

type ListenerState = 'stopped' | 'starting' | 'running' | 'error';

interface ListenerInfo {
  integrationId: string;
  profileName: string;
  process: ChildProcess | null;
  state: ListenerState;
  lastError: string | null;
  startedAt: Date | null;
  readyAt: Date | null;
  restartCount: number;
}

const listeners = new Map<string, ListenerInfo>();
const EVENT_TYPE = 'minutes.minute.generated_v1';
const MAX_RESTART_DELAY_MS = 60_000;
const RESTART_BASE_DELAY_MS = 5_000;
const READY_TIMEOUT_MS = 15_000;
const READY_MARKER = `[event] ready event_key=${EVENT_TYPE}`;

function getElapsedMs(startedAt: Date | null) {
  return startedAt ? Date.now() - startedAt.getTime() : undefined;
}

function parseNdjson(line: string) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseCliErrorEnvelope(output: string) {
  try {
    const parsed = JSON.parse(output) as {
      ok?: boolean;
      error?: {
        type?: string;
        subtype?: string;
        message?: string;
        hint?: string;
        missing_scopes?: string[];
      };
    };

    if (parsed.ok === false && parsed.error) {
      return parsed.error;
    }
  } catch {
    return null;
  }

  return null;
}

function createEnvelopeFromEvent(event: Record<string, unknown>) {
  const eventPayload = asRecord(event.event) || event;

  return {
    schema: event.schema as string | undefined,
    type: event.type as string | undefined,
    challenge: undefined,
    token: event.token as string | undefined,
    header: {
      event_id: event.event_id as string | undefined,
      event_type: (event.event_type || event.type) as string | undefined,
      create_time: (event.create_time || event.timestamp) as string | undefined,
      token: event.token as string | undefined,
    },
    event: eventPayload,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

async function handleEventLine(line: string, integrationId: string) {
  const event = parseNdjson(line);
  if (!event) {
    return;
  }

  try {
    const integration = await getFeishuIntegrationContextById(integrationId);
    if (!integration) {
      logFeishuMonitor('warn', 'event_listener_integration_not_found', {
        integrationId,
      });
      return;
    }

    const envelope = createEnvelopeFromEvent(event);
    await enqueueFeishuEvent(envelope, integration);
  } catch (error) {
    logFeishuMonitor('error', 'event_listener_handle_event_failed', {
      integrationId,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  }
}

function startListenerForIntegration(integrationId: string, profileName: string): Promise<ListenerInfo> {
  const existing = listeners.get(integrationId);
  if (existing && existing.state === 'running') {
    return Promise.resolve(existing);
  }

  const restartCount = existing?.restartCount ?? 0;

  listeners.set(integrationId, {
    integrationId,
    profileName,
    process: null,
    state: 'starting',
    lastError: null,
    startedAt: new Date(),
    readyAt: null,
    restartCount,
  });

  logFeishuMonitor('info', 'event_listener_starting', {
    integrationId,
    profileName,
    eventType: EVENT_TYPE,
    restartCount,
  });

  return new Promise((resolve, reject) => {
    let ready = false;
    let intentionallyStopped = false;
    const readyTimer = setTimeout(() => {
      const listener = listeners.get(integrationId);
      if (listener && listener.state === 'starting') {
        intentionallyStopped = true;
        listener.state = 'error';
        listener.lastError = `等待 lark-cli ready marker 超时：${READY_MARKER}`;
        listener.readyAt = null;

        if (listener.process && !listener.process.killed) {
          listener.process.kill('SIGTERM');
        }
      }

      logFeishuMonitor('error', 'event_listener_ready_timeout', {
        integrationId,
        profileName,
        eventType: EVENT_TYPE,
        durationMs: getElapsedMs(listener?.startedAt || null),
        restartCount: listener?.restartCount,
      });

      reject(new Error(`等待事件监听 ready 超时：${EVENT_TYPE}`));
    }, READY_TIMEOUT_MS);

    const resolveReady = (listener: ListenerInfo) => {
      if (ready) return;
      ready = true;
      clearTimeout(readyTimer);
      resolve(listener);
    };

    const rejectBeforeReady = (error: Error) => {
      if (ready) return;
      clearTimeout(readyTimer);
      reject(error);
    };

    const cliProcess = spawn('lark-cli', [
      '--profile',
      profileName,
      'event',
      'consume',
      EVENT_TYPE,
      '--as',
      'user',
    ], {
      env: {
        ...global.process.env,
        LARKSUITE_CLI_CONFIG_DIR: global.process.env.LARKSUITE_CLI_CONFIG_DIR || '/app/.lark-cli',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    listeners.get(integrationId)!.process = cliProcess;

    cliProcess.stdout.on('data', (data: Buffer) => {
      const lines = data.toString('utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        handleEventLine(line, integrationId);
      }
    });

    cliProcess.stderr.on('data', (data: Buffer) => {
      const errorMessage = data.toString('utf-8').trim();
      const listener = listeners.get(integrationId);

      if (errorMessage.includes(READY_MARKER)) {
        if (listener) {
          listener.state = 'running';
          listener.readyAt = new Date();
          listener.lastError = null;
        }

        logFeishuMonitor('info', 'event_listener_ready', {
          integrationId,
          profileName,
          eventType: EVENT_TYPE,
          durationMs: getElapsedMs(listener?.startedAt || null),
          restartCount: listener?.restartCount,
        });
        if (listener) {
          resolveReady(listener);
        }
        return;
      }

      logFeishuMonitor('warn', 'event_listener_stderr', {
        integrationId,
        profileName,
        message: errorMessage,
        state: listener?.state,
      });

      const cliError = parseCliErrorEnvelope(errorMessage);
      if (listener) {
        listener.lastError = errorMessage;
      }

      if (cliError && !ready) {
        if (listener) {
          listener.state = 'error';
          listener.lastError = cliError.message || errorMessage;
          listener.readyAt = null;
        }

        logFeishuMonitor('error', 'event_listener_cli_error', {
          integrationId,
          profileName,
          eventType: EVENT_TYPE,
          errorType: cliError.type,
          errorSubtype: cliError.subtype,
          missingScopes: cliError.missing_scopes,
          hint: cliError.hint,
        });

        rejectBeforeReady(new Error(cliError.message || `事件监听启动失败：${EVENT_TYPE}`));
      }
    });

    cliProcess.on('close', (code: number | null, signal: string | null) => {
      logFeishuMonitor('info', 'event_listener_closed', {
        integrationId,
        code,
        signal,
      });

      const listener = listeners.get(integrationId);
      if (!listener) {
        rejectBeforeReady(new Error(`事件监听进程退出：code=${code}, signal=${signal}`));
        return;
      }

      listener.state = 'stopped';
      listener.process = null;
      listener.readyAt = null;

      rejectBeforeReady(new Error(`事件监听进程退出：code=${code}, signal=${signal}`));

      if (code !== 0 && !intentionallyStopped) {
        scheduleRestart(integrationId, profileName);
      }
    });

    cliProcess.on('error', (error: Error) => {
      logFeishuMonitor('error', 'event_listener_error', {
        integrationId,
        message: error.message,
      });

      const listener = listeners.get(integrationId);
      if (listener) {
        listener.state = 'error';
        listener.lastError = error.message;
        listener.process = null;
        listener.readyAt = null;
      }

      rejectBeforeReady(error);
      scheduleRestart(integrationId, profileName);
    });
  });
}

let restartTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRestart(integrationId: string, profileName: string) {
  if (restartTimers.has(integrationId)) {
    return;
  }

  const listener = listeners.get(integrationId);
  const restartCount = (listener?.restartCount ?? 0) + 1;
  const delayMs = Math.min(
    RESTART_BASE_DELAY_MS * Math.pow(2, restartCount),
    MAX_RESTART_DELAY_MS
  );

  if (listener) {
    listener.restartCount = restartCount;
  }

  logFeishuMonitor('info', 'event_listener_scheduled_restart', {
    integrationId,
    delayMs,
    restartCount,
  });

  const timer = setTimeout(() => {
    restartTimers.delete(integrationId);
    void startListenerForIntegration(integrationId, profileName).catch((error) => {
      logFeishuMonitor('error', 'event_listener_restart_ready_failed', {
        integrationId,
        profileName,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, delayMs);

  restartTimers.set(integrationId, timer);
}

export function stopListener(integrationId: string) {
  const listener = listeners.get(integrationId);
  if (!listener) {
    return;
  }

  if (restartTimers.has(integrationId)) {
    clearTimeout(restartTimers.get(integrationId)!);
    restartTimers.delete(integrationId);
  }

  if (listener.process) {
    listener.process.kill();
    listener.process = null;
  }

  listener.state = 'stopped';
  listener.readyAt = null;

  logFeishuMonitor('info', 'event_listener_stopped', {
    integrationId,
    profileName: listener.profileName,
  });
}

export async function startListener(integrationId: string) {
  stopListener(integrationId);

  return getDb()
    .select({ profileName: feishuIntegrations.profileName })
    .from(feishuIntegrations)
    .where(and(eq(feishuIntegrations.id, integrationId), isNull(feishuIntegrations.deletedAt)))
    .limit(1)
    .then((result) => {
      const profileName = result[0]?.profileName;
      if (!profileName) {
        logFeishuMonitor('warn', 'event_listener_no_profile', {
          integrationId,
          stage: 'start_listener',
        });
        throw new Error('当前集成缺少 CLI profile');
      }

      return startListenerForIntegration(integrationId, profileName);
    })
    .catch((error) => {
      logFeishuMonitor('error', 'event_listener_start_failed', {
        integrationId,
        stage: 'start_listener',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
}

export async function startAllListeners() {
  try {
    const db = getDb();
    const integrations = await db
      .select({ id: feishuIntegrations.id, profileName: feishuIntegrations.profileName })
      .from(feishuIntegrations)
      .where(and(isNull(feishuIntegrations.deletedAt), not(isNull(feishuIntegrations.profileName))));

    logFeishuMonitor('info', 'event_listener_start_all', {
      count: integrations.length,
      stage: 'start_all_listeners',
    });

    for (const integration of integrations) {
      void startListenerForIntegration(integration.id, integration.profileName!).catch((error) => {
        logFeishuMonitor('error', 'event_listener_start_all_ready_failed', {
          integrationId: integration.id,
          profileName: integration.profileName,
          stage: 'start_all_listeners',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  } catch (error) {
    logFeishuMonitor('error', 'event_listener_start_all_failed', {
      stage: 'start_all_listeners',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function getListenerStatus(integrationId: string): ListenerInfo | undefined {
  return listeners.get(integrationId);
}

export function getAllListenersStatus(): ListenerInfo[] {
  return Array.from(listeners.values());
}
