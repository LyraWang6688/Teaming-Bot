import type { AnalysisResult } from '@/types';
import type { FeishuBitableConfig } from '../common/config';
import { callGlobalBaseAppTenantOpenApi } from '../integration/integrationOpenApi';
import type { FeishuIntegrationContext } from '../integration/integrationStore';
import {
  getFeishuProjectById,
  getEnabledOrgTargetContextById,
  getOrgTargetContextById,
  type FeishuOrgTargetContext,
} from '../projects/projectConfigStore';
import { type FeishuProcessStatus } from '../pipeline/status';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

type RecordFields = Record<string, unknown>;

type BitableRecord = {
  record_id: string;
  fields: RecordFields;
};

type RecordSearchResult = {
  items?: BitableRecord[];
  has_more?: boolean;
  page_token?: string;
};

type RecordCreateOrGetResult = {
  record: BitableRecord;
};

type RecordBatchGetResult = {
  records?: BitableRecord[];
  absent_record_ids?: string[];
  forbidden_record_ids?: string[];
};

type BitableTextSegment = {
  text?: unknown;
  type?: unknown;
};

type BitableLinkValue = {
  text?: unknown;
  link?: unknown;
};

export type FeishuMeetingRecord = {
  recordId: string;
  meetingId?: string;
  processStatus?: unknown;
  transcript?: unknown;
  summary?: unknown;
  reportUrl?: unknown;
  errorMessage?: unknown;
  analysisData: AnalysisResult | null;
};

export type FeishuBitableAccess = FeishuBitableConfig & {
  orgTarget?: FeishuOrgTargetContext;
  /** 显式指定 projectId（bootstrap / 交付任务按固定项目执行时使用，不依赖当前 active 项目） */
  projectIdOverride?: string;
  /** 触发本次 Base 写入的集成 ID（仅用于日志/审计，不参与 API 调用） */
  integrationId: string;
  /** 触发本次 Base 写入的用户 ID（仅用于日志/审计，不参与 API 调用） */
  userId: string;
};

export async function createOrgTargetBitableAccess(
  integration: Pick<FeishuIntegrationContext, 'id' | 'userId' | 'selectedOrgTargetId'>,
  orgTarget: FeishuOrgTargetContext
): Promise<FeishuBitableAccess> {
  const project = await getFeishuProjectById(orgTarget.projectId);
  return {
    appToken: project?.bitableAppToken ?? '',
    tableId: project?.bitableTableId ?? '',
    integrationId: integration.id,
    userId: integration.userId,
    orgTarget,
  };
}

export async function createSelectedOrgTargetBitableAccess(
  integration: Pick<FeishuIntegrationContext, 'id' | 'userId' | 'selectedOrgTargetId'>,
  options?: { allowDisabled?: boolean }
): Promise<FeishuBitableAccess> {
  const baseConfig = { appToken: '', tableId: '' };

  if (!integration.selectedOrgTargetId) {
    return {
      ...baseConfig,
      integrationId: integration.id,
      userId: integration.userId,
    };
  }

  const orgTarget = options?.allowDisabled
    ? await getOrgTargetContextById(integration.selectedOrgTargetId)
    : await getEnabledOrgTargetContextById(integration.selectedOrgTargetId);

  if (!orgTarget) {
    return {
      ...baseConfig,
      integrationId: integration.id,
      userId: integration.userId,
    };
  }

  return createOrgTargetBitableAccess(integration, orgTarget);
}

async function callBitableOpenApi<T = unknown>(
  _config: FeishuBitableAccess,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  data?: Record<string, unknown>
): Promise<T> {
  // Base 读写统一走平台级独立飞书应用（tenant_access_token），
  // 凭证来自环境变量 FEISHU_BASE_APP_ID / FEISHU_BASE_APP_SECRET，
  // 与集成初始化创建的应用（用于 OAuth / 事件订阅 / IM 推送）相互独立。
  return callGlobalBaseAppTenantOpenApi<T>(method, path, data);
}

function extractBitableText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || undefined;
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object') {
          const segment = item as BitableTextSegment;
          return typeof segment.text === 'string' ? segment.text : '';
        }

        return '';
      })
      .join('')
      .trim();

    return normalized || undefined;
  }

  if (value && typeof value === 'object') {
    const segment = value as BitableTextSegment;
    if (typeof segment.text === 'string') {
      const normalized = segment.text.trim();
      return normalized || undefined;
    }
  }

  return undefined;
}

function extractSelectValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || undefined;
  }

  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' && item.trim());
    return typeof first === 'string' ? first.trim() : undefined;
  }

  return undefined;
}

function extractBitableLink(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || undefined;
  }

  if (value && typeof value === 'object') {
    const linkValue = value as BitableLinkValue;
    if (typeof linkValue.link === 'string') {
      const normalized = linkValue.link.trim();
      return normalized || undefined;
    }
  }

  return extractBitableText(value);
}

function parseAnalysisData(value: unknown): AnalysisResult | null {
  const normalized = extractBitableText(value);
  if (!normalized) return null;

  try {
    return JSON.parse(normalized) as AnalysisResult;
  } catch (error) {
    logRuntimeMonitor('warn', 'feishu_bitable', 'analysis_json_parse_failed', {
      ...toRuntimeErrorContext(error),
      valueLength: normalized.length,
    });
    return null;
  }
}

function toRecord(record: BitableRecord): FeishuMeetingRecord {
  const fields = record.fields || {};

  return {
    recordId: record.record_id,
    meetingId: extractBitableText(fields['会议ID']),
    processStatus: extractSelectValue(fields['处理状态']) || fields['处理状态'],
    transcript: extractBitableText(fields['会议文字稿']),
    summary: extractBitableText(fields['分析摘要']),
    reportUrl: extractBitableLink(fields['报告链接']),
    errorMessage: extractBitableText(fields['错误信息']),
    analysisData: parseAnalysisData(fields['JSON数据']),
  };
}

export async function getBitableRecord(
  config: FeishuBitableAccess,
  recordId: string
): Promise<FeishuMeetingRecord> {
  const result = await callBitableOpenApi<RecordBatchGetResult>(
    config,
    'POST',
    `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records/batch_get`,
    {
      record_ids: [recordId],
      user_id_type: 'open_id',
      with_shared_url: false,
      automatic_fields: false,
    }
  );

  if (result.forbidden_record_ids?.includes(recordId)) {
    throw new Error(`没有权限读取记录: ${recordId}`);
  }

  if (result.absent_record_ids?.includes(recordId) || !result.records?.length) {
    throw new Error(`记录不存在: ${recordId}`);
  }

  return toRecord(result.records[0]);
}

export async function findMeetingRecordByMeetingId(
  config: FeishuBitableAccess,
  meetingId: string,
  meetingIdFieldName = '会议ID'
): Promise<FeishuMeetingRecord | null> {
  const result = await callBitableOpenApi<RecordSearchResult>(
    config,
    'POST',
    `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records/search?page_size=1`,
    {
      filter: {
        conjunction: 'and',
        conditions: [
          {
            field_name: meetingIdFieldName,
            operator: 'is',
            value: [meetingId],
          },
        ],
      },
      automatic_fields: false,
    }
  );

  const record = result.items?.[0];
  return record ? toRecord(record) : null;
}

export async function createMeetingRecord(
  config: FeishuBitableAccess,
  fields: RecordFields
): Promise<FeishuMeetingRecord> {
  const result = await callBitableOpenApi<RecordCreateOrGetResult>(
    config,
    'POST',
    `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records?user_id_type=open_id`,
    { fields }
  );

  return toRecord(result.record);
}

export async function updateMeetingRecordFields(
  config: FeishuBitableAccess,
  recordId: string,
  fields: RecordFields
): Promise<void> {
  await callBitableOpenApi<RecordCreateOrGetResult>(
    config,
    'PUT',
    `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records/${recordId}?user_id_type=open_id`,
    { fields }
  );
}

type FieldListResult = {
  items?: Array<{
    field_id?: unknown;
    field_name?: unknown;
    type?: unknown;
    ui_type?: unknown;
  }>;
  has_more?: boolean;
  page_token?: string;
};

/**
 * 飞书表字段元数据（已规范化）
 * - fieldId/fieldName：稳定 ID 与当前展示名（改名后 fieldId 不变）
 * - type：归一化的写入类型 text | select | other（url 样式文本仍归 text）
 * - rawType/rawUiType：飞书原始类型码与 ui_type，调试用
 */
export type BitableFieldMeta = {
  fieldId: string;
  fieldName: string;
  type: 'text' | 'select' | 'other';
  rawType: number | null;
  rawUiType: string | null;
};

function normalizeBitableFieldType(rawType: unknown, rawUiType: unknown): BitableFieldMeta['type'] {
  const uiType = typeof rawUiType === 'string' ? rawUiType.toLowerCase() : '';
  if (uiType === 'text' || uiType === 'url') return 'text';
  if (uiType === 'singleselect') return 'select';

  const code = typeof rawType === 'number' ? rawType : Number.NaN;
  // 1=多行文本，15=超链接（写入协议与文本一致），3=单选
  if (code === 1 || code === 15) return 'text';
  if (code === 3) return 'select';
  return 'other';
}

/**
 * 列出目标表全部字段（自动分页）。
 * 用于字段绑定 bootstrap 与改名自愈刷新。
 */
export async function listBitableFields(config: FeishuBitableAccess): Promise<BitableFieldMeta[]> {
  const fields: BitableFieldMeta[] = [];
  let pageToken: string | undefined;

  do {
    const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '';
    const result = await callBitableOpenApi<FieldListResult>(
      config,
      'GET',
      `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/fields?page_size=100${suffix}`
    );

    for (const item of result.items ?? []) {
      const fieldId = typeof item.field_id === 'string' ? item.field_id : '';
      const fieldName = typeof item.field_name === 'string' ? item.field_name : '';
      if (!fieldId || !fieldName) continue;
      fields.push({
        fieldId,
        fieldName,
        type: normalizeBitableFieldType(item.type, item.ui_type),
        rawType: typeof item.type === 'number' ? item.type : null,
        rawUiType: typeof item.ui_type === 'string' ? item.ui_type : null,
      });
    }

    pageToken = result.has_more ? result.page_token : undefined;
  } while (pageToken);

  return fields;
}

export async function setMeetingProcessStatus(
  config: FeishuBitableAccess,
  recordId: string,
  status: FeishuProcessStatus,
  options?: { processStatusFieldName?: string; extraFields?: RecordFields }
): Promise<void> {
  // 字段名由调用方经 fieldBinding 解析（运营改名后仍指向正确字段），缺省回退约定名
  const processStatusFieldName = options?.processStatusFieldName ?? '处理状态';
  await updateMeetingRecordFields(config, recordId, {
    [processStatusFieldName]: status,
    ...(options?.extraFields ?? {}),
  });
}
