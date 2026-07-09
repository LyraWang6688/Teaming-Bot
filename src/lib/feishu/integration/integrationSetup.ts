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
import { getListenerStatus, startListener } from '../events/eventListenerManager';
import {
  getEnabledOrgTargetContextById,
  updateOrgTargetFieldCheckStatus,
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

function validateMeetingTableFields(fields: NonNullable<BitableFieldListResult['items']>) {
  const fieldByName = new Map(fields.map((field) => [field.field_name, field]));
  const missingFields: string[] = [];
  const typeMismatches: Array<{
    fieldName: string;
    expectedType: number;
    expectedUiType?: string;
    actualType: number;
  }> = [];

  for (const required of REQUIRED_MEETING_FIELDS) {
    const actual = fieldByName.get(required.fieldName);
    if (!actual) {
      missingFields.push(required.fieldName);
      continue;
    }

    if (actual.type !== required.type) {
      typeMismatches.push({
        fieldName: required.fieldName,
        expectedType: required.type,
        expectedUiType: required.uiType,
        actualType: actual.type,
      });
    }
  }

  return {
    passed: missingFields.length === 0 && typeMismatches.length === 0,
    requiredFields: REQUIRED_MEETING_FIELDS.map((field) => field.fieldName),
    existingFields: fields.map((field) => field.field_name),
    missingFields,
    typeMismatches,
    checkedAt: new Date().toISOString(),
  };
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

  if (!integration.profileName) {
    const failure = {
      type: 'missing_profile',
      message: '当前集成缺少 CLI profile，无法启动事件监听。',
    };
    statuses.eventSubscriptionStatus = 'failed';
    failures.push(failure);
    details.eventSubscription = {
      ok: false,
      eventKey: 'minutes.minute.generated_v1',
      message: failure.message,
    };
  } else if (statuses.oauthStatus !== 'authorized') {
    statuses.eventSubscriptionStatus = 'pending';
    details.eventSubscription = {
      ok: false,
      pending: true,
      eventKey: 'minutes.minute.generated_v1',
      profileName: integration.profileName,
      message: '请先完成飞书用户授权，系统才能启动事件监听。',
    };
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
        eventKey: 'minutes.minute.generated_v1',
        listenerStatus: listener.state,
        profileName: integration.profileName,
        readyAt: listener.readyAt?.toISOString() || null,
        message: '事件监听已启动并可消费。',
      };
    } catch (error) {
      const failure = pickFailure(error, 'EventListenerCheckFailed');
      statuses.eventSubscriptionStatus = 'failed';
      failures.push(failure);
      details.eventSubscription = {
        ok: false,
        eventKey: 'minutes.minute.generated_v1',
        profileName: integration.profileName,
        message: failure.message,
      };
    }
  }

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
      const fieldCheckDetails =
        selectedOrgTarget.fieldCheckStatus === 'success'
          ? selectedOrgTarget.fieldCheckDetails
          : validateMeetingTableFields(fields);

      if (selectedOrgTarget.fieldCheckStatus === 'success') {
        logRuntimeMonitor('info', 'integration_checks', 'org_target_field_check_reused', {
          userId: options.userId,
          integrationId: integration.id,
          projectId: selectedOrgTarget.projectId,
          orgTargetId: selectedOrgTarget.id,
          orgKey: selectedOrgTarget.orgKey,
          orgName: selectedOrgTarget.orgName,
          tableId: selectedOrgTarget.tableId,
          fieldCount: fields.length,
        });
      } else {
        logRuntimeMonitor('info', 'integration_checks', 'org_target_field_check_started', {
          userId: options.userId,
          integrationId: integration.id,
          projectId: selectedOrgTarget.projectId,
          orgTargetId: selectedOrgTarget.id,
          orgKey: selectedOrgTarget.orgKey,
          orgName: selectedOrgTarget.orgName,
          tableId: selectedOrgTarget.tableId,
          fieldCount: fields.length,
        });
      }

      if (
        selectedOrgTarget.fieldCheckStatus !== 'success' &&
        fieldCheckDetails &&
        typeof fieldCheckDetails === 'object' &&
        'passed' in fieldCheckDetails &&
        fieldCheckDetails.passed !== true
      ) {
        logRuntimeMonitor('warn', 'integration_checks', 'org_target_field_check_failed', {
          userId: options.userId,
          integrationId: integration.id,
          projectId: selectedOrgTarget.projectId,
          orgTargetId: selectedOrgTarget.id,
          orgKey: selectedOrgTarget.orgKey,
          orgName: selectedOrgTarget.orgName,
          tableId: selectedOrgTarget.tableId,
          fieldCheckDetails,
        });

        await updateOrgTargetFieldCheckStatus({
          orgTargetId: selectedOrgTarget.id,
          status: 'failed',
          details: fieldCheckDetails as Record<string, unknown>,
        });

        const missingFields = Array.isArray(fieldCheckDetails.missingFields)
          ? fieldCheckDetails.missingFields.join('、')
          : '';
        const typeMismatches = Array.isArray(fieldCheckDetails.typeMismatches)
          ? fieldCheckDetails.typeMismatches
              .map((item) =>
                item && typeof item === 'object' && 'fieldName' in item
                  ? String(item.fieldName)
                  : ''
              )
              .filter(Boolean)
              .join('、')
          : '';

        throw new Error(
          [
            missingFields ? `目标表格缺少字段：${missingFields}` : '',
            typeMismatches ? `目标表格字段类型不匹配：${typeMismatches}` : '',
          ]
            .filter(Boolean)
            .join('；') || '目标表格模板字段校验未通过。'
        );
      }

      if (selectedOrgTarget.fieldCheckStatus !== 'success') {
        await updateOrgTargetFieldCheckStatus({
          orgTargetId: selectedOrgTarget.id,
          status: 'success',
          details: fieldCheckDetails as Record<string, unknown>,
        });

        logRuntimeMonitor('info', 'integration_checks', 'org_target_field_check_succeeded', {
          userId: options.userId,
          integrationId: integration.id,
          projectId: selectedOrgTarget.projectId,
          orgTargetId: selectedOrgTarget.id,
          orgKey: selectedOrgTarget.orgKey,
          orgName: selectedOrgTarget.orgName,
          tableId: selectedOrgTarget.tableId,
          fieldCheckDetails,
        });
      }

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
        fieldCheckStatus:
          selectedOrgTarget.fieldCheckStatus === 'success' ? 'success' : 'checked_and_cached',
        fieldCheckDetails,
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
