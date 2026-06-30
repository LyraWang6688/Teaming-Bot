import { FEISHU_STATUS_OPTIONS } from '../pipeline/status';
import {
  callFeishuIntegrationUserOpenApi,
} from './integrationOpenApi';
import { logRuntimeMonitor } from '@/lib/platform/runtimeMonitor';
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

const REQUIRED_MEETING_FIELDS: RequiredFieldDefinition[] = [
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

function toBitableFieldPayload(field: RequiredFieldDefinition) {
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

  statuses.appCredentialStatus = 'success';
  details.appCredential = {
    ok: true,
    appId: integration.appId,
    note: '应用凭证已保存，使用用户身份进行 API 调用。',
  };

  const authorizationContext = await getLatestFeishuAuthorizationContext(integration.id);
  if (!authorizationContext || authorizationContext.status !== 'authorized') {
    statuses.oauthStatus = 'pending';
    details.oauth = {
      ok: false,
      pending: true,
      message: '当前集成尚未完成 CLI 用户授权。',
    };
  } else {
    statuses.oauthStatus = 'authorized';
    details.oauth = {
      ok: true,
      openId: authorizationContext.authorizedOpenId || null,
      name: authorizationContext.authorizedUserName || null,
      scope: authorizationContext.scope,
      credentialMode: 'cli_profile',
    };
  }

  if (integration.secrets.baseAppToken && integration.meetingTableId) {
    try {
      const appInfo = await callFeishuIntegrationUserOpenApi<BitableAppInfoResult>(
        integration,
        'GET',
        `/bitable/v1/apps/${integration.secrets.baseAppToken}`
      );
      const fields = await listAllBitableFields(
        integration,
        integration.secrets.baseAppToken,
        integration.meetingTableId
      );

      statuses.baseStatus = 'success';
      details.base = {
        ok: true,
        appToken: integration.secrets.baseAppToken,
        tableId: integration.meetingTableId,
        appName: appInfo.app?.name || null,
        defaultTableId: appInfo.app?.default_table_id || null,
        fieldCount: fields.length,
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

  details.eventSubscription = {
    ok: statuses.eventSubscriptionStatus === 'success',
    message:
      statuses.eventSubscriptionStatus === 'success'
        ? '事件监听已配置并生效。'
        : '尚未配置事件监听，请确认 CLI 事件监听已启动。',
  };

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
        '当前真实检查已验证 Base 访问可用，并确认 OAuth 授权 scope 覆盖会议信息、妙记导出与持续访问权限；会议事件仍会在首次真实链路中继续验证。',
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
      note: '需要先完成 OAuth 与 Base 初始化，系统才能验证用户授权 scope 是否完整。',
    };
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
