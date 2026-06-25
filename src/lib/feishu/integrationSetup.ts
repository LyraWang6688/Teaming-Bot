import { FEISHU_STATUS_OPTIONS } from './status';
import {
  callFeishuIntegrationTenantOpenApi,
  callFeishuIntegrationUserOpenApi,
  getTenantAccessTokenForIntegration,
} from './integrationOpenApi';
import {
  getUserFeishuIntegrationContext,
  getLatestFeishuAuthorizationContext,
  upsertFeishuIntegrationCheckStatus,
  updateUserFeishuIntegration,
  writeAuditLog,
} from './integrationStore';

type CheckStatus = 'success' | 'failed' | 'pending' | 'authorized';

type IntegrationCheckStatuses = {
  appCredentialStatus: CheckStatus;
  permissionStatus: CheckStatus;
  eventSubscriptionStatus: CheckStatus;
  webhookStatus: CheckStatus;
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

type BitableTableListResult = {
  items?: Array<{
    table_id: string;
    name?: string;
  }>;
};

type BitableCreateTableResult = {
  table?: {
    table_id?: string;
    name?: string;
  };
};

type BitableFieldListResult = {
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

type FeishuUserInfoResult = {
  open_id?: string;
  name?: string;
  en_name?: string;
  email?: string;
  user_id?: string;
};

type RequiredFieldDefinition = {
  fieldName: string;
  type: number;
  property?: Record<string, unknown>;
};

type CheckFailure = {
  type: string;
  message: string;
};

const REQUIRED_MEETING_FIELDS: RequiredFieldDefinition[] = [
  { fieldName: '会议ID', type: 1 },
  { fieldName: '会议主题', type: 1 },
  { fieldName: '开始时间', type: 5 },
  { fieldName: '结束时间', type: 5 },
  { fieldName: '组织者', type: 1 },
  {
    fieldName: '处理状态',
    type: 3,
    property: {
      options: FEISHU_STATUS_OPTIONS.map((option) => ({
        name: option.name,
        color: option.color,
      })),
    },
  },
  { fieldName: '会议文字稿', type: 1 },
  { fieldName: '分析摘要', type: 1 },
  { fieldName: '报告链接', type: 15 },
  { fieldName: 'JSON数据', type: 1 },
  { fieldName: '错误信息', type: 1 },
];

function isAllChecksPassed(statuses: IntegrationCheckStatuses): boolean {
  return (
    statuses.appCredentialStatus === 'success' &&
    statuses.permissionStatus === 'success' &&
    statuses.eventSubscriptionStatus === 'success' &&
    statuses.webhookStatus === 'success' &&
    statuses.oauthStatus === 'authorized' &&
    statuses.baseStatus === 'success'
  );
}

function createInitialStatuses(hasWebhook: boolean): IntegrationCheckStatuses {
  return {
    appCredentialStatus: 'pending',
    permissionStatus: 'pending',
    eventSubscriptionStatus: hasWebhook ? 'success' : 'pending',
    webhookStatus: hasWebhook ? 'success' : 'pending',
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

  const fieldList = await callFeishuIntegrationTenantOpenApi<BitableFieldListResult>(
    integration,
    'GET',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=500`
  );
  const existingFields = fieldList.items || [];
  const existingFieldNames = new Set(existingFields.map((field) => field.field_name));
  const createdFields: string[] = [];

  for (const field of REQUIRED_MEETING_FIELDS) {
    if (existingFieldNames.has(field.fieldName)) {
      continue;
    }

    await callFeishuIntegrationTenantOpenApi<BitableCreateFieldResult>(
      integration,
      'POST',
      `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
      {
        field_name: field.fieldName,
        type: field.type,
        ...(field.property ? { property: field.property } : {}),
      }
    );
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
  const statuses = createInitialStatuses(Boolean(integration.lastWebhookReceivedAt));
  const requiredUserScopes = parseScopeList(integration.oauthScope);
  const requiredAppPermissions = integration.requiredPermissions.filter(
    (permission) => !requiredUserScopes.includes(permission)
  );
  const details: Record<string, unknown> = {
    checkedAt: checkedAt.toISOString(),
    integrationId: integration.id,
    integrationName: integration.name,
  };
  const failures: CheckFailure[] = [];

  try {
    await getTenantAccessTokenForIntegration(integration);
    statuses.appCredentialStatus = 'success';
    details.appCredential = {
      ok: true,
      appId: integration.appId,
    };
  } catch (error) {
    const failure = pickFailure(error, 'AppCredentialCheckFailed');
    statuses.appCredentialStatus = 'failed';
    failures.push(failure);
    details.appCredential = {
      ok: false,
      message: failure.message,
    };
  }

  try {
    const oauthUser = await callFeishuIntegrationUserOpenApi<FeishuUserInfoResult>(
      integration,
      'GET',
      '/authen/v1/user_info'
    );
    statuses.oauthStatus = 'authorized';
    details.oauth = {
      ok: true,
      openId: oauthUser.open_id || null,
      name: oauthUser.name || oauthUser.en_name || null,
      email: oauthUser.email || null,
    };
  } catch (error) {
    const failure = pickFailure(error, 'OauthCheckFailed');
    if (failure.message.includes('尚未完成 OAuth 授权')) {
      statuses.oauthStatus = 'pending';
      details.oauth = {
        ok: false,
        pending: true,
        message: failure.message,
      };
    } else {
      statuses.oauthStatus = 'failed';
      failures.push(failure);
      details.oauth = {
        ok: false,
        message: failure.message,
      };
    }
  }

  if (integration.secrets.baseAppToken && integration.meetingTableId) {
    try {
      const appInfo = await callFeishuIntegrationTenantOpenApi<BitableAppInfoResult>(
        integration,
        'GET',
        `/bitable/v1/apps/${integration.secrets.baseAppToken}`
      );
      const fieldList = await callFeishuIntegrationTenantOpenApi<BitableFieldListResult>(
        integration,
        'GET',
        `/bitable/v1/apps/${integration.secrets.baseAppToken}/tables/${integration.meetingTableId}/fields?page_size=500`
      );

      statuses.baseStatus = 'success';
      details.base = {
        ok: true,
        appToken: integration.secrets.baseAppToken,
        tableId: integration.meetingTableId,
        appName: appInfo.app?.name || null,
        defaultTableId: appInfo.app?.default_table_id || null,
        fieldCount: fieldList.items?.length || 0,
      };
    } catch (error) {
      const failure = pickFailure(error, 'BaseCheckFailed');
      statuses.baseStatus = 'failed';
      failures.push(failure);
      details.base = {
        ok: false,
        appToken: integration.secrets.baseAppToken,
        tableId: integration.meetingTableId,
        message: failure.message,
      };
    }
  } else {
    details.base = {
      ok: false,
      pending: true,
      appTokenSaved: Boolean(integration.secrets.baseAppToken),
      tableIdSaved: Boolean(integration.meetingTableId),
      message: '尚未完成 Base 初始化。',
    };
  }

  details.webhook = {
    ok: statuses.webhookStatus === 'success',
    lastWebhookReceivedAt: integration.lastWebhookReceivedAt,
    message:
      statuses.webhookStatus === 'success'
        ? '已收到飞书回调。'
        : '尚未收到 Webhook challenge 或真实事件回调。',
  };
  details.eventSubscription = {
    ok: statuses.eventSubscriptionStatus === 'success',
    inferredFromWebhook: true,
    message:
      statuses.eventSubscriptionStatus === 'success'
        ? '已通过收到的 Webhook 回调推断事件订阅已生效。'
        : '当前通过是否收到 Webhook 回调来间接判断事件订阅是否生效。',
  };

  const authorization = await getLatestFeishuAuthorizationContext(integration.id);
  const grantedUserScopes = parseScopeList(authorization?.scope);
  const missingUserScopes = requiredUserScopes.filter((scope) => !grantedUserScopes.includes(scope));
  const hasRecordedAuthorizationScope = requiredUserScopes.length === 0 || grantedUserScopes.length > 0;

  if (
    statuses.appCredentialStatus === 'success' &&
    statuses.oauthStatus === 'authorized' &&
    statuses.baseStatus === 'success' &&
    hasRecordedAuthorizationScope &&
    missingUserScopes.length === 0
  ) {
    statuses.permissionStatus = 'success';
    details.permission = {
      ok: true,
      strategy: 'oauth_scope + bitable_base_access',
      requiredAppPermissions,
      requiredUserScopes,
      grantedUserScopes,
      note:
        '当前真实检查已验证 Base 访问可用，并确认 OAuth 授权 scope 覆盖会议信息、会议录制、妙记导出与持续访问权限；会议事件与妙记资源仍会在首次真实链路中继续验证。',
    };
  } else if (
    statuses.appCredentialStatus === 'success' &&
    statuses.oauthStatus === 'authorized' &&
    statuses.baseStatus === 'success' &&
    !hasRecordedAuthorizationScope
  ) {
    statuses.permissionStatus = 'failed';
    details.permission = {
      ok: false,
      requiredAppPermissions,
      requiredUserScopes,
      grantedUserScopes,
      missingUserScopes: requiredUserScopes,
      note: '已完成 OAuth，但当前授权记录缺少 scope 信息，无法确认权限是否齐全，请重新发起授权。',
    };
  } else if (
    statuses.appCredentialStatus === 'success' &&
    statuses.oauthStatus === 'authorized' &&
    statuses.baseStatus === 'success' &&
    missingUserScopes.length > 0
  ) {
    statuses.permissionStatus = 'failed';
    details.permission = {
      ok: false,
      requiredAppPermissions,
      requiredUserScopes,
      grantedUserScopes,
      missingUserScopes,
      note: '当前 OAuth 授权缺少部分用户权限，请在飞书开放平台补齐 scope 后重新授权。',
    };
  } else if (
    statuses.appCredentialStatus === 'failed' ||
    statuses.oauthStatus === 'failed' ||
    statuses.baseStatus === 'failed'
  ) {
    statuses.permissionStatus = 'failed';
    details.permission = {
      ok: false,
      note: '由于应用凭证、OAuth 或 Base 资源访问存在失败项，权限检查判定为未通过。',
    };
  } else {
    statuses.permissionStatus = 'pending';
    details.permission = {
      ok: false,
      pending: true,
      requiredAppPermissions,
      requiredUserScopes,
      grantedUserScopes,
      missingUserScopes,
      note: '需要先完成 OAuth 与 Base 初始化，系统才能验证应用权限和用户授权 scope 是否完整。',
    };
  }

  const firstFailure = failures[0] || null;
  await upsertFeishuIntegrationCheckStatus({
    integrationId: integration.id,
    appCredentialStatus: statuses.appCredentialStatus,
    permissionStatus: statuses.permissionStatus,
    eventSubscriptionStatus: statuses.eventSubscriptionStatus,
    webhookStatus: statuses.webhookStatus,
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
      setupStep: 'check',
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

  if (!appToken) {
    const createAppResult = await callFeishuIntegrationTenantOpenApi<BitableCreateAppResult>(
      integration,
      'POST',
      '/bitable/v1/apps',
      {
        name: `${integration.name} 会议信息`,
      }
    );

    appToken = createAppResult.app?.app_token || null;
    tableId = createAppResult.app?.default_table_id || tableId;
    createdApp = true;
  }

  if (!appToken) {
    throw new Error('Base 初始化失败：未能获取 app_token。');
  }

  if (!tableId) {
    const tableList = await callFeishuIntegrationTenantOpenApi<BitableTableListResult>(
      integration,
      'GET',
      `/bitable/v1/apps/${appToken}/tables?page_size=100`
    );
    tableId = tableList.items?.[0]?.table_id || null;
  }

  if (!tableId) {
    const createTableResult = await callFeishuIntegrationTenantOpenApi<BitableCreateTableResult>(
      integration,
      'POST',
      `/bitable/v1/apps/${appToken}/tables`,
      {
        table_name: '会议信息',
      }
    );
    tableId = createTableResult.table?.table_id || null;
    createdTable = true;
  }

  if (!tableId) {
    throw new Error('Base 初始化失败：未能获取 table_id。');
  }

  const ensuredFields = await ensureMeetingTableFields(
    options.userId,
    options.integrationId,
    appToken,
    tableId
  );

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
      createdFields: ensuredFields.createdFields,
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
    createdFields: ensuredFields.createdFields,
    fieldCount: ensuredFields.fieldCount,
    checkResult,
  };
}
