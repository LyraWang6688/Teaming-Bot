import type { AnalysisResult } from '@/types';
import type { FeishuBitableConfig } from '../common/config';
import { callFeishuIntegrationUserOpenApi } from '../integration/integrationOpenApi';
import type { FeishuIntegrationContext } from '../integration/integrationStore';
import {
  getEnabledOrgTargetContextById,
  getOrgTargetContextById,
  type FeishuOrgTargetContext,
} from '../projects/projectConfigStore';
import { FEISHU_PROCESS_STATUS, type FeishuProcessStatus } from '../pipeline/status';
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
  integration: FeishuIntegrationContext;
  orgTarget?: FeishuOrgTargetContext;
};

export function createOrgTargetBitableAccess(
  integration: FeishuIntegrationContext,
  orgTarget: FeishuOrgTargetContext
): FeishuBitableAccess {
  return {
    appToken: orgTarget.baseAppToken,
    tableId: orgTarget.tableId,
    integration,
    orgTarget,
  };
}

export async function createSelectedOrgTargetBitableAccess(
  integration: FeishuIntegrationContext,
  options?: { allowDisabled?: boolean }
): Promise<FeishuBitableAccess> {
  if (!integration.selectedOrgTargetId) {
    throw new Error('请先选择所在组织，系统才能确定写入的多维表格。');
  }

  const orgTarget = options?.allowDisabled
    ? await getOrgTargetContextById(integration.selectedOrgTargetId)
    : await getEnabledOrgTargetContextById(integration.selectedOrgTargetId);

  if (!orgTarget) {
    throw new Error('当前组织对应的多维表格配置不可用，请联系管理员确认项目配置。');
  }

  return createOrgTargetBitableAccess(integration, orgTarget);
}

async function callBitableOpenApi<T = unknown>(
  config: FeishuBitableAccess,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  data?: Record<string, unknown>
): Promise<T> {
  return callFeishuIntegrationUserOpenApi<T>(config.integration, method, path, data);
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
  meetingId: string
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
            field_name: '会议ID',
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

export async function listMeetingRecordsByStatuses(
  config: FeishuBitableAccess,
  statuses: FeishuProcessStatus[],
  pageSize = 20
): Promise<FeishuMeetingRecord[]> {
  const records: FeishuMeetingRecord[] = [];

  for (const status of statuses) {
    let pageToken: string | undefined;

    do {
      const query = new URLSearchParams({ page_size: String(pageSize) });
      if (pageToken) {
        query.set('page_token', pageToken);
      }

      const result = await callBitableOpenApi<RecordSearchResult>(
        config,
        'POST',
        `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records/search?${query.toString()}`,
        {
          filter: {
            conjunction: 'and',
            conditions: [
              {
                field_name: '处理状态',
                operator: 'is',
                value: [status],
              },
            ],
          },
          automatic_fields: false,
        }
      );

      records.push(...(result.items || []).map(toRecord));
      pageToken = result.has_more ? result.page_token : undefined;
    } while (pageToken);
  }

  return records;
}

export async function createMeetingRecord(
  config: FeishuBitableAccess,
  fields: RecordFields
): Promise<FeishuMeetingRecord> {
  const result = await callBitableOpenApi<RecordCreateOrGetResult>(
    config,
    'POST',
    `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`,
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
    `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records/${recordId}`,
    { fields }
  );
}

export async function upsertMeetingWaitingRecord(
  config: FeishuBitableAccess,
  meeting: {
    meetingId: string;
  }
): Promise<FeishuMeetingRecord> {
  const existing = await findMeetingRecordByMeetingId(config, meeting.meetingId);
  const fields: RecordFields = {
    '会议ID': meeting.meetingId,
    '处理状态': FEISHU_PROCESS_STATUS.minuteGenerated,
  };

  if (existing) {
    await updateMeetingRecordFields(config, existing.recordId, fields);
    return { ...existing, ...meeting, processStatus: FEISHU_PROCESS_STATUS.minuteGenerated };
  }

  return createMeetingRecord(config, fields);
}

export async function setMeetingProcessStatus(
  config: FeishuBitableAccess,
  recordId: string,
  status: FeishuProcessStatus,
  extraFields: RecordFields = {}
): Promise<void> {
  await updateMeetingRecordFields(config, recordId, {
    '处理状态': status,
    ...extraFields,
  });
}
