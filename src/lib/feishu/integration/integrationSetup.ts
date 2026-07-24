import {
  callFeishuIntegrationUserOpenApi,
} from './integrationOpenApi';
import { createFeishuSdkClient } from './sdkClient';
import { getValidIntegrationUserAuthorization } from './tokenService';
import { logRuntimeMonitor } from '@/lib/platform/runtimeMonitor';
import {
  getUserFeishuIntegrationContext,
  getLatestFeishuAuthorizationContext,
  upsertFeishuIntegrationCheckStatus,
  updateUserFeishuIntegration,
  writeAuditLog,
} from './integrationStore';
import { activateLatestFeishuIntegrationInGroup } from './integrationActivationService';
import { getListenerStatus, startListener, stopListener } from '../events/eventListenerManager';
import {
  getEnabledOrgTargetContextById,
} from '../projects/projectConfigStore';
import { FEISHU_REQUIRED_USER_EVENTS } from './integrationConstants';

type CheckStatus = 'success' | 'failed' | 'pending' | 'authorized';

type IntegrationCheckStatuses = {
  appCredentialStatus: CheckStatus;
  permissionStatus: CheckStatus;
  minuteSubscriptionStatus: CheckStatus;
  eventSubscriptionStatus: CheckStatus;
  oauthStatus: CheckStatus;
  baseStatus: CheckStatus;
};

type IntegrationCheckResult = {
  statuses: IntegrationCheckStatuses;
  allPassed: boolean;
  details: Record<string, unknown>;
  metadata?: {
    staleSnapshot?: boolean;
    snapshot?: IntegrationCheckSnapshot;
    currentSnapshot?: IntegrationCheckSnapshot;
  };
};

const CHECK_FLIGHTS_KEY = '__feishu_integration_check_flights';
const MINUTE_GENERATED_EVENT = FEISHU_REQUIRED_USER_EVENTS[0];

function getIntegrationCheckFlights(): Map<string, Promise<IntegrationCheckResult>> {
  const globalStore = globalThis as Record<string, unknown>;
  if (!globalStore[CHECK_FLIGHTS_KEY]) {
    globalStore[CHECK_FLIGHTS_KEY] = new Map<string, Promise<IntegrationCheckResult>>();
  }
  return globalStore[CHECK_FLIGHTS_KEY] as Map<string, Promise<IntegrationCheckResult>>;
}

type BitableAppInfoResult = {
  app?: {
    app_token?: string;
    default_table_id?: string;
    name?: string;
    url?: string;
  };
};

type BitableFieldListResult = {
  has_more?: boolean;
  page_token?: string;
  items?: Array<{
    field_id: string;
    field_name: string;
    type: number;
  }>;
};

type CheckFailure = {
  type: string;
  message: string;
};

type ListenerPrerequisiteFailure = {
  code: string;
  gate: string;
  status?: CheckStatus;
  message: string;
};

type IntegrationCheckSnapshot = {
  integrationUpdatedAt: string;
  selectedOrgTargetId: string | null;
  authorizationStatus: string | null;
  authorizationUpdatedAt: string | null;
};

function buildIntegrationCheckSnapshot(options: {
  integration: NonNullable<Awaited<ReturnType<typeof getUserFeishuIntegrationContext>>>;
  authorization: Awaited<ReturnType<typeof getLatestFeishuAuthorizationContext>> | null;
}): IntegrationCheckSnapshot {
  return {
    integrationUpdatedAt: options.integration.updatedAt,
    selectedOrgTargetId: options.integration.selectedOrgTargetId || null,
    authorizationStatus: options.authorization?.status || null,
    authorizationUpdatedAt: options.authorization?.updatedAt || null,
  };
}

function createIntegrationCheckFlightKey(options: {
  userId: string;
  integrationId: string;
  snapshot: IntegrationCheckSnapshot;
}): string {
  return [
    options.userId,
    options.integrationId,
    options.snapshot.integrationUpdatedAt,
    options.snapshot.selectedOrgTargetId || 'no-org-target',
    options.snapshot.authorizationStatus || 'no-auth',
    options.snapshot.authorizationUpdatedAt || 'no-auth-updated-at',
  ].join(':');
}

function isIntegrationCheckSnapshotStale(
  snapshot: IntegrationCheckSnapshot,
  currentSnapshot: IntegrationCheckSnapshot
): boolean {
  return (
    snapshot.integrationUpdatedAt !== currentSnapshot.integrationUpdatedAt ||
    snapshot.selectedOrgTargetId !== currentSnapshot.selectedOrgTargetId ||
    snapshot.authorizationStatus !== currentSnapshot.authorizationStatus ||
    snapshot.authorizationUpdatedAt !== currentSnapshot.authorizationUpdatedAt
  );
}

function isAllChecksPassed(statuses: IntegrationCheckStatuses): boolean {
  return (
    statuses.appCredentialStatus === 'success' &&
    statuses.permissionStatus === 'success' &&
    statuses.minuteSubscriptionStatus === 'success' &&
    statuses.eventSubscriptionStatus === 'success' &&
    statuses.oauthStatus === 'authorized' &&
    statuses.baseStatus === 'success'
  );
}

function createInitialStatuses(): IntegrationCheckStatuses {
  return {
    appCredentialStatus: 'pending',
    permissionStatus: 'pending',
    minuteSubscriptionStatus: 'pending',
    eventSubscriptionStatus: 'pending',
    oauthStatus: 'pending',
    baseStatus: 'pending',
  };
}

function pickFailure(error: unknown, fallbackType: string): CheckFailure {
  if (error instanceof Error) {
    return {
      type: error.name || fallbackType,
      message: error.message,
    };
  }

  return {
    type: fallbackType,
    message: String(error),
  };
}

function parseScopeList(value: string | null | undefined): string[] {
  return (value || '')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getListenerPrerequisiteFailures(
  statuses: IntegrationCheckStatuses,
  hasSelectedOrgTarget: boolean
): ListenerPrerequisiteFailure[] {
  const failures: ListenerPrerequisiteFailure[] = [];

  if (statuses.appCredentialStatus !== 'success') {
    failures.push({
      code:
        statuses.appCredentialStatus === 'failed'
          ? 'app_credential_failed'
          : 'app_credential_pending',
      gate: 'app_credential',
      status: statuses.appCredentialStatus,
      message: '飞书应用凭证尚未通过校验。',
    });
  }

  if (statuses.oauthStatus !== 'authorized') {
    failures.push({
      code: statuses.oauthStatus === 'failed' ? 'oauth_failed' : 'oauth_pending',
      gate: 'oauth',
      status: statuses.oauthStatus,
      message: '飞书用户授权尚未完成或已失效。',
    });
  }

  if (!hasSelectedOrgTarget) {
    failures.push({
      code: 'organization_not_selected',
      gate: 'organization',
      message: '尚未选择组织。',
    });
  }

  if (statuses.baseStatus !== 'success') {
    failures.push({
      code: statuses.baseStatus === 'failed' ? 'base_access_failed' : 'base_access_pending',
      gate: 'base',
      status: statuses.baseStatus,
      message: '目标多维表格尚未通过可访问校验。',
    });
  }

  if (statuses.permissionStatus !== 'success') {
    failures.push({
      code:
        statuses.permissionStatus === 'failed'
          ? 'permission_scope_failed'
          : 'permission_scope_pending',
      gate: 'permission',
      status: statuses.permissionStatus,
      message: '飞书用户权限尚未通过校验。',
    });
  }

  if (
    statuses.appCredentialStatus === 'success' &&
    statuses.oauthStatus === 'authorized' &&
    hasSelectedOrgTarget &&
    statuses.baseStatus === 'success' &&
    statuses.permissionStatus === 'success' &&
    statuses.minuteSubscriptionStatus !== 'success'
  ) {
    failures.push({
      code:
        statuses.minuteSubscriptionStatus === 'failed'
          ? 'minute_change_subscription_failed'
          : 'minute_change_subscription_pending',
      gate: 'minute_subscription',
      status: statuses.minuteSubscriptionStatus,
      message: '当前授权用户尚未完成妙记生成事件订阅。',
    });
  }

  return failures;
}

async function subscribeMinuteGeneratedEvent(options: {
  userId: string;
  integration: NonNullable<Awaited<ReturnType<typeof getUserFeishuIntegrationContext>>>;
}): Promise<void> {
  logRuntimeMonitor('info', 'integration_checks', 'minute_change_subscription_started', {
    userId: options.userId,
    integrationId: options.integration.id,
    eventType: MINUTE_GENERATED_EVENT,
    mode: 'user_openapi',
  });

  try {
    await callFeishuIntegrationUserOpenApi<Record<string, never>>(
      options.integration,
      'POST',
      '/minutes/v1/minutes/subscription',
      { event_type: MINUTE_GENERATED_EVENT }
    );
    logRuntimeMonitor('info', 'integration_checks', 'minute_change_subscription_succeeded', {
      userId: options.userId,
      integrationId: options.integration.id,
      eventType: MINUTE_GENERATED_EVENT,
      mode: 'user_openapi',
    });
  } catch (error) {
    const failure = pickFailure(error, 'MinuteChangeSubscriptionFailed');
    logRuntimeMonitor('error', 'integration_checks', 'minute_change_subscription_failed', {
      userId: options.userId,
      integrationId: options.integration.id,
      eventType: MINUTE_GENERATED_EVENT,
      mode: 'user_openapi',
      ...failure,
    });
    throw error;
  }
}

async function listAllBitableFields(
  integration: NonNullable<Awaited<ReturnType<typeof getUserFeishuIntegrationContext>>>,
  appToken: string,
  tableId: string
): Promise<NonNullable<BitableFieldListResult['items']>> {
  const fields: NonNullable<BitableFieldListResult['items']> = [];
  let pageToken: string | undefined;

  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (pageToken) {
      query.set('page_token', pageToken);
    }

    const fieldList = await callFeishuIntegrationUserOpenApi<BitableFieldListResult>(
      integration,
      'GET',
      `/bitable/v1/apps/${appToken}/tables/${tableId}/fields?${query.toString()}`
    );

    fields.push(...(fieldList.items || []));
    pageToken = fieldList.has_more ? fieldList.page_token : undefined;
  } while (pageToken);

  return fields;
}

async function executeFeishuIntegrationChecks(options: {
  userId: string;
  integrationId: string;
}): Promise<IntegrationCheckResult> {
  const integration = await getUserFeishuIntegrationContext(options.userId, options.integrationId);
  if (!integration) {
    throw new Error('未找到对应的飞书集成配置。');
  }

  const checkedAt = new Date();
  const statuses = createInitialStatuses();
  const requiredUserScopes = parseScopeList(integration.oauthScope);
  const details: Record<string, unknown> = {
    checkedAt: checkedAt.toISOString(),
    integrationId: integration.id,
    integrationName: integration.name,
  };
  const failures: CheckFailure[] = [];

  try {
    details.appRegistration = {
      provider: 'node_sdk',
      configurationMode: 'registration_finalization_only',
      reconfigurationAttempted: false,
      note: '真实检查只读取验证应用，不会重复修改或发布应用。',
    };
    const client = createFeishuSdkClient(integration);
    const appResponse = await client.application.v6.application.get({
      path: { app_id: integration.appId },
      params: { lang: 'zh_cn' },
    });
    if (typeof appResponse.code === 'number' && appResponse.code !== 0) {
      throw new Error(appResponse.msg || '读取飞书应用信息失败。');
    }
    statuses.appCredentialStatus = 'success';
    details.appCredential = {
      ok: true,
      appId: integration.appId,
      appName: appResponse.data?.app?.app_name || integration.name,
      credentialMode: 'database_encrypted',
      note: '已使用数据库中的加密应用凭证完成飞书真实接口校验。',
    };
  } catch (error) {
    const failure = pickFailure(error, 'AppCredentialCheckFailed');
    statuses.appCredentialStatus = 'failed';
    failures.push(failure);
    details.appCredential = {
      ok: false,
      appId: integration.appId,
      message: failure.message,
    };
  }

  let authorizationContext = await getLatestFeishuAuthorizationContext(integration.id);
  const initialSnapshot = buildIntegrationCheckSnapshot({
    integration,
    authorization: authorizationContext,
  });
  if (!authorizationContext || authorizationContext.status !== 'authorized') {
    statuses.oauthStatus = 'pending';
    details.oauth = {
      ok: false,
      pending: true,
      message: '当前集成尚未完成有效的飞书用户授权。',
    };
  } else {
    try {
      authorizationContext = await getValidIntegrationUserAuthorization(integration);
      statuses.oauthStatus = 'authorized';
      details.oauth = {
        ok: true,
        openId: authorizationContext.authorizedOpenId || null,
        name: authorizationContext.authorizedUserName || null,
        scope: authorizationContext.scope,
        accessTokenExpiresAt: authorizationContext.accessTokenExpiresAt.toISOString(),
        refreshTokenExpiresAt: authorizationContext.refreshTokenExpiresAt?.toISOString() || null,
        credentialMode: 'database_token_service',
      };
    } catch (error) {
      const failure = pickFailure(error, 'OAuthTokenCheckFailed');
      statuses.oauthStatus = 'failed';
      failures.push(failure);
      details.oauth = {
        ok: false,
        message: failure.message,
      };
    }
  }

  statuses.eventSubscriptionStatus = 'pending';
  details.eventSubscription = {
    ok: false,
    pending: true,
    eventKey: MINUTE_GENERATED_EVENT,
    provider: 'node_sdk_ws',
    minuteChangeSubscription: {
      ok: false,
      pending: true,
      provider: 'user_openapi',
      eventKey: MINUTE_GENERATED_EVENT,
      message: '妙记生成事件会在用户授权、Base 与权限校验通过后订阅。',
    },
    message: '事件长连接会在妙记事件订阅、组织、Base 与用户权限全部通过后启动。',
  };

  const selectedOrgTarget = integration.selectedOrgTargetId
    ? await getEnabledOrgTargetContextById(integration.selectedOrgTargetId)
    : null;

  if (!integration.selectedOrgTargetId) {
    details.organization = {
      ok: false,
      pending: true,
      message: '请先选择所在组织。',
    };
    details.base = {
      ok: false,
      pending: true,
      message: '尚未选择组织，无法确定目标多维表格。',
    };
  } else if (!selectedOrgTarget) {
    const failure = {
      type: 'org_target_unavailable',
      message: '所选组织对应的多维表格配置不可用，请联系管理员确认当前项目配置。',
    };
    statuses.baseStatus = 'failed';
    failures.push(failure);
    details.organization = {
      ok: false,
      selectedOrgTargetId: integration.selectedOrgTargetId,
      message: failure.message,
    };
    details.base = {
      ok: false,
      message: failure.message,
    };
  } else if (statuses.oauthStatus !== 'authorized') {
    details.organization = {
      ok: true,
      projectId: selectedOrgTarget.projectId,
      orgTargetId: selectedOrgTarget.id,
      orgKey: selectedOrgTarget.orgKey,
      orgName: selectedOrgTarget.orgName,
    };
    details.base = {
      ok: false,
      pending: true,
      appToken: selectedOrgTarget.baseAppToken,
      tableId: selectedOrgTarget.tableId,
      baseUrl: selectedOrgTarget.baseUrl,
      message: '请先完成飞书用户授权，系统才能检查目标多维表格访问权限。',
    };
  } else {
    try {
      logRuntimeMonitor('info', 'integration_checks', 'org_target_access_check_started', {
        userId: options.userId,
        integrationId: integration.id,
        projectId: selectedOrgTarget.projectId,
        orgTargetId: selectedOrgTarget.id,
        orgKey: selectedOrgTarget.orgKey,
        orgName: selectedOrgTarget.orgName,
        tableId: selectedOrgTarget.tableId,
      });

      const appInfo = await callFeishuIntegrationUserOpenApi<BitableAppInfoResult>(
        integration,
        'GET',
        `/bitable/v1/apps/${selectedOrgTarget.baseAppToken}`
      );
      const fields = await listAllBitableFields(
        integration,
        selectedOrgTarget.baseAppToken,
        selectedOrgTarget.tableId
      );
      statuses.baseStatus = 'success';
      details.organization = {
        ok: true,
        projectId: selectedOrgTarget.projectId,
        orgTargetId: selectedOrgTarget.id,
        orgKey: selectedOrgTarget.orgKey,
        orgName: selectedOrgTarget.orgName,
      };
      details.base = {
        ok: true,
        appToken: selectedOrgTarget.baseAppToken,
        tableId: selectedOrgTarget.tableId,
        baseUrl: selectedOrgTarget.baseUrl,
        appName: appInfo.app?.name || null,
        defaultTableId: appInfo.app?.default_table_id || null,
        fieldCount: fields.length,
        validationMode: 'read_access_only',
        message: '当前授权用户可以访问所选组织对应的多维表格。',
      };

      logRuntimeMonitor('info', 'integration_checks', 'org_target_access_check_succeeded', {
        userId: options.userId,
        integrationId: integration.id,
        projectId: selectedOrgTarget.projectId,
        orgTargetId: selectedOrgTarget.id,
        orgKey: selectedOrgTarget.orgKey,
        orgName: selectedOrgTarget.orgName,
        tableId: selectedOrgTarget.tableId,
        fieldCount: fields.length,
        appName: appInfo.app?.name || null,
      });
    } catch (error) {
      const failure = pickFailure(error, 'BaseCheckFailed');
      statuses.baseStatus = 'failed';
      failures.push(failure);
      logRuntimeMonitor('error', 'integration_checks', 'org_target_access_check_failed', {
        userId: options.userId,
        integrationId: integration.id,
        projectId: selectedOrgTarget.projectId,
        orgTargetId: selectedOrgTarget.id,
        orgKey: selectedOrgTarget.orgKey,
        orgName: selectedOrgTarget.orgName,
        tableId: selectedOrgTarget.tableId,
        ...pickFailure(error, 'BaseCheckFailed'),
      });
      details.base = {
        ok: false,
        appToken: selectedOrgTarget.baseAppToken,
        tableId: selectedOrgTarget.tableId,
        baseUrl: selectedOrgTarget.baseUrl,
        message: failure.message,
      };
    }
  }

  const grantedUserScopes = parseScopeList(authorizationContext?.scope);
  const missingUserScopes = requiredUserScopes.filter((scope) => !grantedUserScopes.includes(scope));
  const hasRecordedAuthorizationScope = requiredUserScopes.length === 0 || grantedUserScopes.length > 0;

  if (
    statuses.oauthStatus === 'authorized' &&
    statuses.baseStatus === 'success' &&
    hasRecordedAuthorizationScope &&
    missingUserScopes.length === 0
  ) {
    statuses.permissionStatus = 'success';
    details.permission = {
      ok: true,
      strategy: 'oauth_scope',
      requiredUserScopes,
      grantedUserScopes,
      note:
        '当前真实检查已验证目标多维表格可访问，并确认 OAuth 授权 scope 覆盖会议信息、妙记导出与持续访问权限；会议事件仍会在首次真实链路中继续验证。',
    };
  } else if (
    statuses.oauthStatus === 'authorized' &&
    statuses.baseStatus === 'success' &&
    !hasRecordedAuthorizationScope
  ) {
    statuses.permissionStatus = 'failed';
    details.permission = {
      ok: false,
      requiredUserScopes,
      grantedUserScopes,
      missingUserScopes: requiredUserScopes,
      note: '已完成 OAuth，但当前授权记录缺少 scope 信息，无法确认权限是否齐全，请重新发起授权。',
    };
  } else if (
    statuses.oauthStatus === 'authorized' &&
    statuses.baseStatus === 'success' &&
    missingUserScopes.length > 0
  ) {
    statuses.permissionStatus = 'failed';
    details.permission = {
      ok: false,
      requiredUserScopes,
      grantedUserScopes,
      missingUserScopes,
      note: '当前 OAuth 授权缺少部分用户权限，请重新发起授权。',
    };
  } else if (
    statuses.baseStatus === 'failed'
  ) {
    statuses.permissionStatus = 'failed';
    details.permission = {
      ok: false,
      note: '由于 OAuth 或 Base 资源访问存在失败项，权限检查判定为未通过。',
    };
  } else {
    statuses.permissionStatus = 'pending';
    details.permission = {
      ok: false,
      pending: true,
      requiredUserScopes,
      grantedUserScopes,
      missingUserScopes,
      note: '需要先选择组织、完成 OAuth，并确认目标多维表格可访问，系统才能验证用户授权 scope 是否完整。',
    };
  }

  if (
    statuses.appCredentialStatus === 'success' &&
    statuses.oauthStatus === 'authorized' &&
    statuses.baseStatus === 'success' &&
    statuses.permissionStatus === 'success' &&
    Boolean(integration.selectedOrgTargetId)
  ) {
    try {
      await subscribeMinuteGeneratedEvent({
        userId: options.userId,
        integration,
      });
      statuses.minuteSubscriptionStatus = 'success';
      details.eventSubscription = {
        ok: false,
        pending: true,
        eventKey: MINUTE_GENERATED_EVENT,
        provider: 'node_sdk_ws',
        minuteChangeSubscription: {
          ok: true,
          provider: 'user_openapi',
          eventKey: MINUTE_GENERATED_EVENT,
          message: '当前授权用户已完成妙记生成事件订阅。',
        },
        message: '当前授权用户已完成妙记事件订阅，正在建立消费级事件长连接。',
      };
    } catch (error) {
      const failure = pickFailure(error, 'MinuteChangeSubscriptionFailed');
      statuses.minuteSubscriptionStatus = 'failed';
      failures.push(failure);
      details.eventSubscription = {
        ok: false,
        eventKey: MINUTE_GENERATED_EVENT,
        provider: 'node_sdk_ws',
        reasonCode: failure.type,
        blockedGate: 'minute_subscription',
        minuteChangeSubscription: {
          ok: false,
          provider: 'user_openapi',
          eventKey: MINUTE_GENERATED_EVENT,
          reasonCode: failure.type,
          message: failure.message,
        },
        message: '当前授权用户的妙记生成事件订阅失败，暂时不能建立事件长连接。',
      };
    }
  }

  const listenerPrerequisiteFailures = getListenerPrerequisiteFailures(
    statuses,
    Boolean(integration.selectedOrgTargetId)
  );
  const primaryListenerBlocker = listenerPrerequisiteFailures[0] || null;

  const latestIntegration = await getUserFeishuIntegrationContext(options.userId, options.integrationId);
  const latestAuthorization = latestIntegration
    ? await getLatestFeishuAuthorizationContext(latestIntegration.id)
    : null;
  const currentSnapshot =
    latestIntegration
      ? buildIntegrationCheckSnapshot({
          integration: latestIntegration,
          authorization: latestAuthorization,
        })
      : initialSnapshot;
  const snapshotStale = isIntegrationCheckSnapshotStale(initialSnapshot, currentSnapshot);

  if (snapshotStale) {
    logRuntimeMonitor('info', 'integration_checks', 'integration_checks_snapshot_stale', {
      userId: options.userId,
      integrationId: options.integrationId,
      snapshot: initialSnapshot,
      currentSnapshot,
    });

    return {
      statuses,
      allPassed: false,
      details,
      metadata: {
        staleSnapshot: true,
        snapshot: initialSnapshot,
        currentSnapshot,
      },
    };
  }

  // Persist prerequisite gates before asking the listener manager to start.
  // The listener manager deliberately re-reads these database states so a
  // manual route or process restart cannot bypass the onboarding sequence.
  const prerequisiteFailure = failures[0] || null;
  await upsertFeishuIntegrationCheckStatus({
    integrationId: integration.id,
    appCredentialStatus: statuses.appCredentialStatus,
    permissionStatus: statuses.permissionStatus,
    minuteSubscriptionStatus: statuses.minuteSubscriptionStatus,
    eventSubscriptionStatus: 'pending',
    oauthStatus: statuses.oauthStatus,
    baseStatus: statuses.baseStatus,
    lastCheckedAt: checkedAt,
    lastErrorType: prerequisiteFailure?.type || null,
    lastErrorMessage: prerequisiteFailure?.message || null,
    details,
  });

  const listenerPrerequisitesPassed =
    statuses.appCredentialStatus === 'success' &&
    statuses.oauthStatus === 'authorized' &&
    statuses.baseStatus === 'success' &&
    statuses.permissionStatus === 'success' &&
    statuses.minuteSubscriptionStatus === 'success' &&
    Boolean(integration.selectedOrgTargetId);

  if (listenerPrerequisitesPassed) {
      const activation = await activateLatestFeishuIntegrationInGroup(integration.id);
      activation?.supersededIntegrationIds.forEach((supersededIntegrationId) => {
        stopListener(supersededIntegrationId);
      });

      if (activation && !activation.isCurrentActive) {
        statuses.eventSubscriptionStatus = 'pending';
        details.eventSubscription = {
          ok: false,
          pending: true,
          eventKey: MINUTE_GENERATED_EVENT,
          provider: 'node_sdk_ws',
          reasonCode: 'integration_inactive',
          blockedGate: 'activation',
          prerequisiteFailures: [
            {
              code: 'integration_inactive',
              gate: 'activation',
              message: '当前集成已被同一飞书账号在该组织目标下更新创建的应用替代，不再启动事件长连接。',
            },
          ],
          latestActiveIntegrationId: activation.activeIntegrationId,
          minuteChangeSubscription: {
            ok: true,
            provider: 'user_openapi',
            eventKey: MINUTE_GENERATED_EVENT,
            message: '当前授权用户已完成妙记生成事件订阅。',
          },
          message: '当前集成不是该飞书账号在当前组织目标下的最新应用，系统不会为它启动事件长连接。',
        };
        logRuntimeMonitor('info', 'integration_checks', 'event_listener_gate_blocked', {
          userId: options.userId,
          integrationId: integration.id,
          eventKey: MINUTE_GENERATED_EVENT,
          provider: 'node_sdk_ws',
          reasonCode: 'integration_inactive',
          blockedGate: 'activation',
          latestActiveIntegrationId: activation.activeIntegrationId,
          statuses,
          minuteSubscriptionStatus: statuses.minuteSubscriptionStatus,
          prerequisiteFailures: [
            {
              code: 'integration_inactive',
              gate: 'activation',
              message: '当前集成已被同一飞书账号在该组织目标下更新创建的应用替代，不再启动事件长连接。',
            },
          ],
          selectedOrgTargetId: integration.selectedOrgTargetId || null,
        });
      } else {
        try {
          const existingListener = getListenerStatus(integration.id);
          const listener =
            existingListener?.state === 'running' && existingListener.readyAt
              ? existingListener
              : await startListener(integration.id);
          statuses.eventSubscriptionStatus = 'success';
          details.eventSubscription = {
            ok: true,
            eventKey: MINUTE_GENERATED_EVENT,
            provider: 'node_sdk_ws',
            minuteChangeSubscription: {
              ok: true,
              provider: 'user_openapi',
              eventKey: MINUTE_GENERATED_EVENT,
              message: '当前授权用户已完成妙记生成事件订阅。',
            },
            listenerStatus: listener.state,
            readyAt: listener.readyAt?.toISOString() || null,
            message: '当前授权用户已完成妙记事件订阅，消费级事件长连接已建立。',
          };
          logRuntimeMonitor('info', 'integration_checks', 'event_listener_gate_passed', {
            userId: options.userId,
            integrationId: integration.id,
            eventKey: MINUTE_GENERATED_EVENT,
            provider: 'node_sdk_ws',
            listenerStatus: listener.state,
            readyAt: listener.readyAt?.toISOString() || null,
          });
        } catch (error) {
          const failure = pickFailure(error, 'EventListenerCheckFailed');
          statuses.eventSubscriptionStatus = 'failed';
          failures.push(failure);
          details.eventSubscription = {
            ok: false,
            eventKey: MINUTE_GENERATED_EVENT,
            provider: 'node_sdk_ws',
            reasonCode: failure.type,
            blockedGate: 'event_listener',
            minuteChangeSubscription: {
              ok: true,
              provider: 'user_openapi',
              eventKey: MINUTE_GENERATED_EVENT,
              message: '当前授权用户已完成妙记生成事件订阅。',
            },
            message: failure.message,
          };
          logRuntimeMonitor('error', 'integration_checks', 'event_listener_gate_failed', {
            userId: options.userId,
            integrationId: integration.id,
            eventKey: MINUTE_GENERATED_EVENT,
            provider: 'node_sdk_ws',
            reasonCode: failure.type,
            blockedGate: 'event_listener',
            message: failure.message,
          });
        }
    }
  } else {
    stopListener(integration.id);
    if (statuses.minuteSubscriptionStatus === 'failed') {
      statuses.eventSubscriptionStatus = 'failed';
    } else {
      statuses.eventSubscriptionStatus = 'pending';
      details.eventSubscription = {
        ok: false,
        pending: true,
        eventKey: MINUTE_GENERATED_EVENT,
        provider: 'node_sdk_ws',
        reasonCode: primaryListenerBlocker?.code || 'listener_prerequisites_pending',
        blockedGate: primaryListenerBlocker?.gate || 'unknown',
        prerequisiteFailures: listenerPrerequisiteFailures,
        minuteChangeSubscription:
          statuses.minuteSubscriptionStatus === 'success'
            ? {
                ok: true,
                provider: 'user_openapi',
                eventKey: MINUTE_GENERATED_EVENT,
                message: '当前授权用户已完成妙记生成事件订阅。',
              }
            : {
                ok: false,
                pending: true,
                provider: 'user_openapi',
                eventKey: MINUTE_GENERATED_EVENT,
                message: '需先完成前置校验，系统才会为当前授权用户订阅妙记生成事件。',
              },
        message: '需依次完成应用、授权、组织选择、Base 可访问、权限校验与妙记事件订阅后，才会建立事件长连接。',
      };
    }
    logRuntimeMonitor('info', 'integration_checks', 'event_listener_gate_blocked', {
      userId: options.userId,
      integrationId: integration.id,
      eventKey: MINUTE_GENERATED_EVENT,
      provider: 'node_sdk_ws',
      reasonCode: primaryListenerBlocker?.code || 'listener_prerequisites_pending',
      blockedGate: primaryListenerBlocker?.gate || 'unknown',
      statuses,
      minuteSubscriptionStatus: statuses.minuteSubscriptionStatus,
      prerequisiteFailures: listenerPrerequisiteFailures,
      selectedOrgTargetId: integration.selectedOrgTargetId || null,
    });
  }

  const firstFailure = failures[0] || null;
  await upsertFeishuIntegrationCheckStatus({
    integrationId: integration.id,
    appCredentialStatus: statuses.appCredentialStatus,
    permissionStatus: statuses.permissionStatus,
    minuteSubscriptionStatus: statuses.minuteSubscriptionStatus,
    eventSubscriptionStatus: statuses.eventSubscriptionStatus,
    oauthStatus: statuses.oauthStatus,
    baseStatus: statuses.baseStatus,
    lastCheckedAt: checkedAt,
    lastErrorType: firstFailure?.type || null,
    lastErrorMessage: firstFailure?.message || null,
    details,
  });

  const allPassed = isAllChecksPassed(statuses);
  if (allPassed) {
    await updateUserFeishuIntegration(options.userId, integration.id, {
      status: 'success',
      setupStep: 'event_listener',
      initializedAt: new Date(),
    });
  } else {
    await updateUserFeishuIntegration(options.userId, integration.id, {
      status: 'draft',
      initializedAt: null,
    });
  }

  await writeAuditLog({
    userId: options.userId,
    integrationId: integration.id,
    action: 'integration.checks.ran',
    result: allPassed ? 'success' : failures.length ? 'partial_failed' : 'pending',
    summary: '执行飞书集成真实检查',
    metadata: {
      statuses,
      allPassed,
      listener: {
        reasonCode:
          statuses.eventSubscriptionStatus === 'success'
            ? 'ready'
            : details.eventSubscription &&
                typeof details.eventSubscription === 'object' &&
                'reasonCode' in details.eventSubscription
              ? (details.eventSubscription as { reasonCode?: string }).reasonCode
              : null,
        blockedGate:
          details.eventSubscription &&
          typeof details.eventSubscription === 'object' &&
          'blockedGate' in details.eventSubscription
            ? (details.eventSubscription as { blockedGate?: string }).blockedGate
            : null,
        prerequisiteFailures: listenerPrerequisiteFailures,
      },
    },
  });

  return {
    statuses,
    allPassed,
    details,
    metadata: {
      staleSnapshot: false,
      snapshot: initialSnapshot,
      currentSnapshot,
    },
  };
}

export async function runFeishuIntegrationChecks(options: {
  userId: string;
  integrationId: string;
}): Promise<IntegrationCheckResult> {
  const integration = await getUserFeishuIntegrationContext(options.userId, options.integrationId);
  if (!integration) {
    throw new Error('未找到对应的飞书集成配置。');
  }
  const authorization = await getLatestFeishuAuthorizationContext(integration.id);
  const snapshot = buildIntegrationCheckSnapshot({
    integration,
    authorization,
  });
  const flightKey = createIntegrationCheckFlightKey({
    userId: options.userId,
    integrationId: options.integrationId,
    snapshot,
  });
  const flights = getIntegrationCheckFlights();
  const existingFlight = flights.get(flightKey);
  if (existingFlight) {
    logRuntimeMonitor('info', 'integration_checks', 'integration_checks_joined_inflight', {
      userId: options.userId,
      integrationId: options.integrationId,
      snapshot,
    });
    return existingFlight;
  }

  const flight = executeFeishuIntegrationChecks(options).finally(() => {
    if (flights.get(flightKey) === flight) {
      flights.delete(flightKey);
    }
  });
  flights.set(flightKey, flight);
  return flight;
}
