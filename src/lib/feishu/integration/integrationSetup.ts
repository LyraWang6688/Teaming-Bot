import { FEISHU_STATUS_OPTIONS } from '../pipeline/status';
import {
  callFeishuIntegrationUserOpenApi,
} from './integrationOpenApi';
import { createFeishuSdkClient } from './sdkClient';
import { getValidIntegrationUserAuthorization } from './tokenService';
import { configureFeishuApplication } from './applicationConfigService';
import { logRuntimeMonitor } from '@/lib/platform/runtimeMonitor';
import {
  getUserFeishuIntegrationContext,
  getFeishuIntegrationCheckStatus,
  getLatestFeishuAuthorizationContext,
  upsertFeishuIntegrationCheckStatus,
  updateUserFeishuIntegration,
  writeAuditLog,
} from './integrationStore';
import { getListenerStatus, startListener, stopListener } from '../events/eventListenerManager';
import {
  getEnabledOrgTargetContextById,
} from '../projects/projectConfigStore';

type CheckStatus = 'success' | 'failed' | 'pending' | 'authorized';

type IntegrationCheckStatuses = {
  appCredentialStatus: CheckStatus;
  permissionStatus: CheckStatus;
  eventSubscriptionStatus: CheckStatus;
  oauthStatus: CheckStatus;
  baseStatus: CheckStatus;
};

type BitableAppInfoResult = {
  app?: {
    app_token?: string;
    default_table_id?: string;
    name?: string;
    url?: string;
  };
};

type BitableCreateTableResult = {
  table_id?: string;
  default_view_id?: string;
  field_id_list?: string[];
};

type BitableFieldListResult = {
  has_more?: boolean;
  page_token?: string;
  total?: number;
  items?: Array<{
    field_id: string;
    field_name: string;
    type: number;
  }>;
};

type BitableCreateFieldResult = {
  field?: {
    field_id?: string;
    field_name?: string;
    type?: number;
  };
};

type BitableCreateAppResult = {
  app?: {
    app_token?: string;
    default_table_id?: string;
    name?: string;
    url?: string;
  };
};

type RequiredFieldDefinition = {
  fieldName: string;
  type: number;
  uiType?: string;
  property?: Record<string, unknown>;
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

export const REQUIRED_MEETING_FIELDS: RequiredFieldDefinition[] = [
  { fieldName: '会议ID', type: 1, uiType: 'Text' },
  {
    fieldName: '处理状态',
    type: 3,
    uiType: 'SingleSelect',
    property: {
      options: FEISHU_STATUS_OPTIONS.map((option) => ({
        name: option.name,
        color: option.color,
      })),
    },
  },
  { fieldName: '会议文字稿', type: 1, uiType: 'Text' },
  { fieldName: '分析摘要', type: 1, uiType: 'Text' },
  { fieldName: '报告链接', type: 15, uiType: 'Url' },
  { fieldName: 'JSON数据', type: 1, uiType: 'Text' },
  { fieldName: '错误信息', type: 1, uiType: 'Text' },
];

export function toBitableFieldPayload(field: RequiredFieldDefinition) {
  return {
    field_name: field.fieldName,
    type: field.type,
    ...(field.uiType ? { ui_type: field.uiType } : {}),
    ...(field.property ? { property: field.property } : {}),
  };
}

function isAllChecksPassed(statuses: IntegrationCheckStatuses): boolean {
  return (
    statuses.appCredentialStatus === 'success' &&
    statuses.permissionStatus === 'success' &&
    statuses.eventSubscriptionStatus === 'success' &&
    statuses.oauthStatus === 'authorized' &&
    statuses.baseStatus === 'success'
  );
}

function createInitialStatuses(): IntegrationCheckStatuses {
  return {
    appCredentialStatus: 'pending',
    permissionStatus: 'pending',
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

  return failures;
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

async function ensureMeetingTableFields(
  userId: string,
  integrationId: string,
  appToken: string,
  tableId: string
): Promise<{
  fieldCount: number;
  createdFields: string[];
  existingFields: string[];
}> {
  const integration = await getUserFeishuIntegrationContext(userId, integrationId);
  if (!integration) {
    throw new Error('未找到对应的飞书集成配置。');
  }

  const existingFields = await listAllBitableFields(integration, appToken, tableId);
  const existingFieldNames = new Set(existingFields.map((field) => field.field_name));
  const createdFields: string[] = [];

  for (const field of REQUIRED_MEETING_FIELDS) {
    if (existingFieldNames.has(field.fieldName)) {
      continue;
    }

    try {
      await callFeishuIntegrationUserOpenApi<BitableCreateFieldResult>(
        integration,
        'POST',
        `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
        toBitableFieldPayload(field)
      );
    } catch (error) {
      logRuntimeMonitor('error', 'integration_base', 'base_field_create_failed', {
        userId,
        integrationId,
        appToken,
        tableId,
        fieldName: field.fieldName,
        fieldType: field.type,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    createdFields.push(field.fieldName);
  }

  return {
    fieldCount: existingFields.length + createdFields.length,
    createdFields,
    existingFields: existingFields.map((field) => field.field_name),
  };
}

export async function runFeishuIntegrationChecks(options: {
  userId: string;
  integrationId: string;
}): Promise<{
  statuses: IntegrationCheckStatuses;
  allPassed: boolean;
  details: Record<string, unknown>;
}> {
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
    const persistedChecks = await getFeishuIntegrationCheckStatus(integration.id);
    const registrationDetails =
      persistedChecks?.details?.appRegistration &&
      typeof persistedChecks.details.appRegistration === 'object'
        ? persistedChecks.details.appRegistration as Record<string, unknown>
        : null;
    if (registrationDetails?.applicationConfigured !== true) {
      await configureFeishuApplication({
        userId: integration.userId,
        integrationId: integration.id,
        appId: integration.appId,
        appSecret: integration.secrets.appSecret,
      });
    }
    details.appRegistration = {
      provider: 'node_sdk',
      applicationConfigured: true,
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
    eventKey: 'minutes.minute.generated_v1',
    message: '事件长连接会在组织、Base 与用户权限全部通过后启动。',
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
        fieldCheckStatus: selectedOrgTarget.fieldCheckStatus,
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

  const listenerPrerequisiteFailures = getListenerPrerequisiteFailures(
    statuses,
    Boolean(integration.selectedOrgTargetId)
  );
  const primaryListenerBlocker = listenerPrerequisiteFailures[0] || null;

  // Persist the first four gates before asking the listener manager to start.
  // The listener manager deliberately re-reads these database states so a
  // manual route or process restart cannot bypass the onboarding sequence.
  const prerequisiteFailure = failures[0] || null;
  await upsertFeishuIntegrationCheckStatus({
    integrationId: integration.id,
    appCredentialStatus: statuses.appCredentialStatus,
    permissionStatus: statuses.permissionStatus,
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
    Boolean(integration.selectedOrgTargetId);

  if (listenerPrerequisitesPassed) {
    try {
      const existingListener = getListenerStatus(integration.id);
      const listener =
        existingListener?.state === 'running' && existingListener.readyAt
          ? existingListener
          : await startListener(integration.id);
      statuses.eventSubscriptionStatus = 'success';
      details.eventSubscription = {
        ok: true,
        eventKey: 'minutes.minute.generated_v1',
        provider: 'node_sdk_ws',
        listenerStatus: listener.state,
        readyAt: listener.readyAt?.toISOString() || null,
        message: '消费级事件长连接已建立。',
      };
      logRuntimeMonitor('info', 'integration_checks', 'event_listener_gate_passed', {
        userId: options.userId,
        integrationId: integration.id,
        eventKey: 'minutes.minute.generated_v1',
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
        eventKey: 'minutes.minute.generated_v1',
        provider: 'node_sdk_ws',
        reasonCode: failure.type,
        blockedGate: 'event_listener',
        message: failure.message,
      };
      logRuntimeMonitor('error', 'integration_checks', 'event_listener_gate_failed', {
        userId: options.userId,
        integrationId: integration.id,
        eventKey: 'minutes.minute.generated_v1',
        provider: 'node_sdk_ws',
        reasonCode: failure.type,
        blockedGate: 'event_listener',
        message: failure.message,
      });
    }
  } else {
    stopListener(integration.id);
    statuses.eventSubscriptionStatus = 'pending';
    details.eventSubscription = {
      ok: false,
      pending: true,
      eventKey: 'minutes.minute.generated_v1',
      provider: 'node_sdk_ws',
      reasonCode: primaryListenerBlocker?.code || 'listener_prerequisites_pending',
      blockedGate: primaryListenerBlocker?.gate || 'unknown',
      prerequisiteFailures: listenerPrerequisiteFailures,
      message: '需依次完成应用、授权、组织选择、Base 可访问与权限校验后，才会建立事件长连接。',
    };
    logRuntimeMonitor('info', 'integration_checks', 'event_listener_gate_blocked', {
      userId: options.userId,
      integrationId: integration.id,
      eventKey: 'minutes.minute.generated_v1',
      provider: 'node_sdk_ws',
      reasonCode: primaryListenerBlocker?.code || 'listener_prerequisites_pending',
      blockedGate: primaryListenerBlocker?.gate || 'unknown',
      statuses,
      prerequisiteFailures: listenerPrerequisiteFailures,
      selectedOrgTargetId: integration.selectedOrgTargetId || null,
    });
  }

  const firstFailure = failures[0] || null;
  await upsertFeishuIntegrationCheckStatus({
    integrationId: integration.id,
    appCredentialStatus: statuses.appCredentialStatus,
    permissionStatus: statuses.permissionStatus,
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
  };
}

export async function initializeFeishuIntegrationBase(options: {
  userId: string;
  integrationId: string;
  setupTraceId?: string;
}): Promise<{
  appToken: string;
  tableId: string;
  createdApp: boolean;
  createdTable: boolean;
  createdFields: string[];
  fieldCount: number;
  checkResult: {
    statuses: IntegrationCheckStatuses;
    allPassed: boolean;
    details: Record<string, unknown>;
  };
}> {
  const integration = await getUserFeishuIntegrationContext(options.userId, options.integrationId);
  if (!integration) {
    throw new Error('未找到对应的飞书集成配置。');
  }

  let appToken = integration.secrets.baseAppToken;
  let tableId = integration.meetingTableId;
  let createdApp = false;
  let createdTable = false;
  let createdFieldsFromNewTable: string[] = [];
  const traceContext = {
    setupTraceId: options.setupTraceId,
    userId: options.userId,
    integrationId: options.integrationId,
  };

  if (!appToken) {
    logRuntimeMonitor('info', 'integration_base', 'base_app_create_started', {
      ...traceContext,
      integrationName: integration.name,
    });
    const createAppResult = await callFeishuIntegrationUserOpenApi<BitableCreateAppResult>(
      integration,
      'POST',
      '/bitable/v1/apps',
      {
        name: `${integration.name} 会议信息`,
      }
    );

    appToken = createAppResult.app?.app_token || null;
    createdApp = true;
    logRuntimeMonitor('info', 'integration_base', 'base_app_create_completed', {
      ...traceContext,
      appToken,
      createdApp,
    });
  }

  if (!appToken) {
    throw new Error('Base 初始化失败：未能获取 app_token。');
  }

  if (!tableId) {
    const initialFields = REQUIRED_MEETING_FIELDS.map(toBitableFieldPayload);
    logRuntimeMonitor('info', 'integration_base', 'base_table_create_started', {
      ...traceContext,
      appToken,
      tableName: '会议信息',
      initialFieldCount: initialFields.length,
    });
    const createTableResult = await callFeishuIntegrationUserOpenApi<BitableCreateTableResult>(
      integration,
      'POST',
      `/bitable/v1/apps/${appToken}/tables`,
      {
        table: {
          name: '会议信息',
          fields: initialFields,
        },
      }
    );
    tableId = createTableResult.table_id || null;
    createdTable = true;
    createdFieldsFromNewTable = REQUIRED_MEETING_FIELDS.map((field) => field.fieldName);
    logRuntimeMonitor('info', 'integration_base', 'base_table_create_completed', {
      ...traceContext,
      appToken,
      tableId,
      createdTable,
      initialFieldCount: createdFieldsFromNewTable.length,
    });
  }

  if (!tableId) {
    throw new Error('Base 初始化失败：未能获取 table_id。');
  }

  logRuntimeMonitor('info', 'integration_base', 'base_field_ensure_started', {
    ...traceContext,
    appToken,
    tableId,
    requiredFieldCount: REQUIRED_MEETING_FIELDS.length,
  });
  const ensuredFields = await ensureMeetingTableFields(
    options.userId,
    options.integrationId,
    appToken,
    tableId
  );
  logRuntimeMonitor('info', 'integration_base', 'base_field_ensure_completed', {
    ...traceContext,
    appToken,
    tableId,
    fieldCount: ensuredFields.fieldCount,
    createdFields: [...createdFieldsFromNewTable, ...ensuredFields.createdFields],
    existingFields: ensuredFields.existingFields,
  });

  await updateUserFeishuIntegration(options.userId, integration.id, {
    baseAppToken: appToken,
    meetingTableId: tableId,
    initializedAt: new Date(),
    setupStep: 'base',
  });

  await writeAuditLog({
    userId: options.userId,
    integrationId: integration.id,
    action: 'integration.base.initialized',
    result: 'success',
    summary: '初始化飞书 Base 与会议信息表',
    metadata: {
      appToken,
      tableId,
      createdApp,
      createdTable,
      createdFields: [...createdFieldsFromNewTable, ...ensuredFields.createdFields],
    },
  });

  const checkResult = await runFeishuIntegrationChecks({
    userId: options.userId,
    integrationId: integration.id,
  });

  return {
    appToken,
    tableId,
    createdApp,
    createdTable,
    createdFields: [...createdFieldsFromNewTable, ...ensuredFields.createdFields],
    fieldCount: ensuredFields.fieldCount,
    checkResult,
  };
}
