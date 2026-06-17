import type { AnalysisResult } from '@/types';
import { callFeishuOpenApi } from './openapi';
import type { FeishuBitableConfig } from './config';
import { FEISHU_PROCESS_STATUS, type FeishuProcessStatus } from './status';

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

export type FeishuMeetingRecord = {
  recordId: string;
  meetingId?: string;
  topic?: string;
  startTime?: unknown;
  endTime?: unknown;
  processStatus?: unknown;
  transcript?: unknown;
  summary?: unknown;
  reportUrl?: unknown;
  analysisData: AnalysisResult | null;
};

function parseAnalysisData(value: unknown): AnalysisResult | null {
  if (!value || typeof value !== 'string') return null;

  try {
    return JSON.parse(value) as AnalysisResult;
  } catch (error) {
    console.error('[Feishu Base] JSON数据解析失败:', error);
    return null;
  }
}

function toRecord(record: BitableRecord): FeishuMeetingRecord {
  const fields = record.fields || {};

  return {
    recordId: record.record_id,
    meetingId: fields['会议ID'] as string | undefined,
    topic: fields['会议主题'] as string | undefined,
    startTime: fields['开始时间'],
    endTime: fields['结束时间'],
    processStatus: fields['处理状态'],
    transcript: fields['会议文字稿'],
    summary: fields['分析摘要'],
    reportUrl: fields['报告链接'],
    analysisData: parseAnalysisData(fields['JSON数据']),
  };
}

export async function getBitableRecord(
  config: FeishuBitableConfig,
  recordId: string
): Promise<FeishuMeetingRecord> {
  const result = await callFeishuOpenApi<RecordCreateOrGetResult>(
    'GET',
    `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records/${recordId}`
  );

  return toRecord(result.record);
}

export async function findMeetingRecordByMeetingId(
  config: FeishuBitableConfig,
  meetingId: string
): Promise<FeishuMeetingRecord | null> {
  const result = await callFeishuOpenApi<RecordSearchResult>(
    'POST',
    `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records/search`,
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
      page_size: 1,
    }
  );

  const record = result.items?.[0];
  return record ? toRecord(record) : null;
}

export async function createMeetingRecord(
  config: FeishuBitableConfig,
  fields: RecordFields
): Promise<FeishuMeetingRecord> {
  const result = await callFeishuOpenApi<RecordCreateOrGetResult>(
    'POST',
    `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`,
    { fields }
  );

  return toRecord(result.record);
}

export async function updateMeetingRecordFields(
  config: FeishuBitableConfig,
  recordId: string,
  fields: RecordFields
): Promise<void> {
  await callFeishuOpenApi<RecordCreateOrGetResult>(
    'PUT',
    `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records/${recordId}`,
    { fields }
  );
}

export async function upsertMeetingWaitingRecord(
  config: FeishuBitableConfig,
  meeting: {
    meetingId: string;
    topic?: string;
    startTime?: number;
    endTime?: number;
    organizer?: string;
  }
): Promise<FeishuMeetingRecord> {
  const existing = await findMeetingRecordByMeetingId(config, meeting.meetingId);
  const fields: RecordFields = {
    '会议ID': meeting.meetingId,
    '处理状态': FEISHU_PROCESS_STATUS.waitingNote,
  };

  if (meeting.topic) fields['会议主题'] = meeting.topic;
  if (meeting.startTime) fields['开始时间'] = meeting.startTime;
  if (meeting.endTime) fields['结束时间'] = meeting.endTime;
  if (meeting.organizer) fields['组织者'] = meeting.organizer;

  if (existing) {
    await updateMeetingRecordFields(config, existing.recordId, fields);
    return { ...existing, ...meeting, processStatus: FEISHU_PROCESS_STATUS.waitingNote };
  }

  return createMeetingRecord(config, fields);
}

export async function setMeetingProcessStatus(
  config: FeishuBitableConfig,
  recordId: string,
  status: FeishuProcessStatus,
  extraFields: RecordFields = {}
): Promise<void> {
  await updateMeetingRecordFields(config, recordId, {
    '处理状态': status,
    ...extraFields,
  });
}
