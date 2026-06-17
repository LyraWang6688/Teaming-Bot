/**
 * 飞书 Webhook 异步处理骨架
 *
 * Webhook 请求只负责验收事件并快速返回，耗时工作在后台异步执行。
 * 生产部署时建议将 processedEventIds 和任务状态迁移到数据库/队列，
 * 避免服务重启后丢失去重信息。
 */

import { analyzeMeetingText } from '@/services/analysisService';
import { getFeishuBitableConfig, getProjectPublicUrl } from './config';
import {
  findMeetingRecordByMeetingId,
  setMeetingProcessStatus,
  upsertMeetingWaitingRecord,
} from './bitableOpenApi';
import { FEISHU_PROCESS_STATUS } from './status';
import { fetchTranscriptByDocToken } from './transcript';

type FeishuWebhookHeader = {
  event_id?: string;
  event_type?: string;
  create_time?: string;
  token?: string;
};

export type FeishuWebhookEnvelope = {
  schema?: string;
  type?: string;
  challenge?: string;
  token?: string;
  header?: FeishuWebhookHeader;
  event?: Record<string, unknown>;
};

type EnqueueResult = {
  accepted: boolean;
  duplicate: boolean;
  eventId?: string;
  eventType?: string;
};

const processedEventIds = new Set<string>();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value > 10_000_000_000 ? value : value * 1000;
  }

  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function getEventId(envelope: FeishuWebhookEnvelope): string | undefined {
  return envelope.header?.event_id || (envelope.event?.event_id as string | undefined);
}

function getEventType(envelope: FeishuWebhookEnvelope): string | undefined {
  return envelope.header?.event_type || envelope.type || (envelope.event?.type as string | undefined);
}

function scheduleBackgroundTask(task: () => Promise<void>) {
  setTimeout(() => {
    task().catch((error) => {
      console.error('[Feishu Webhook] 异步任务失败:', error);
    });
  }, 0);
}

export function isValidFeishuWebhookToken(envelope: FeishuWebhookEnvelope): boolean {
  const expectedToken = process.env.FEISHU_WEBHOOK_VERIFICATION_TOKEN;
  if (!expectedToken) return true;

  const actualToken = envelope.token || envelope.header?.token;
  return actualToken === expectedToken;
}

export function enqueueFeishuWebhookEvent(envelope: FeishuWebhookEnvelope): EnqueueResult {
  const eventId = getEventId(envelope);
  const eventType = getEventType(envelope);

  if (!eventId) {
    return { accepted: false, duplicate: false, eventType };
  }

  if (processedEventIds.has(eventId)) {
    return { accepted: true, duplicate: true, eventId, eventType };
  }

  processedEventIds.add(eventId);

  scheduleBackgroundTask(async () => {
    await processFeishuWebhookEvent(envelope);
  });

  return { accepted: true, duplicate: false, eventId, eventType };
}

async function processFeishuWebhookEvent(envelope: FeishuWebhookEnvelope) {
  const eventType = getEventType(envelope);

  switch (eventType) {
    case 'vc.bot.meeting_ended_v1':
    case 'vc.meeting.meeting_ended_v1':
    case 'vc.meeting.participant_meeting_ended_v1':
      await processMeetingEndedEvent(envelope);
      return;

    case 'vc.note.generated_v1':
      await processNoteGeneratedEvent(envelope);
      return;

    default:
      console.info('[Feishu Webhook] 忽略未处理事件:', eventType);
  }
}

async function processMeetingEndedEvent(envelope: FeishuWebhookEnvelope) {
  const event = envelope.event || {};
  const meeting = asRecord(event.meeting);
  const meetingId =
    asString(event.meeting_id) ||
    asString(event.meeting_id_str) ||
    asString(meeting.id) ||
    asString(meeting.meeting_id);

  console.info('[Feishu Webhook] 收到会议结束事件，等待纪要生成:', {
    eventType: getEventType(envelope),
    meetingId,
  });

  if (!meetingId) {
    throw new Error('会议结束事件缺少 meeting_id');
  }

  const config = getFeishuBitableConfig();
  await upsertMeetingWaitingRecord(config, {
    meetingId,
    topic: asString(meeting.topic) || asString(event.topic) || '未命名会议',
    startTime: toTimestamp(meeting.start_time) || toTimestamp(event.start_time),
    endTime: toTimestamp(meeting.end_time) || toTimestamp(event.end_time),
    organizer: asString(event.operator_id) || asString(event.organizer_id),
  });
}

async function processNoteGeneratedEvent(envelope: FeishuWebhookEnvelope) {
  const event = envelope.event || {};
  const note = asRecord(event.note);
  const noteSource = asRecord(event.note_source);
  const meetingId =
    asString(noteSource.source_entity_id) ||
    asString(event.meeting_id) ||
    asString(note.meeting_id);
  const verbatimToken =
    asString(note.verbatim_token) ||
    asString(note.verbatim_doc_token) ||
    asString(event.verbatim_token) ||
    asString(event.verbatim_doc_token);

  console.info('[Feishu Webhook] 收到纪要生成事件，准备异步获取转录稿:', {
    meetingId,
    hasVerbatimToken: Boolean(verbatimToken),
  });

  if (!meetingId) {
    throw new Error('纪要生成事件缺少 meeting_id/source_entity_id');
  }

  const config = getFeishuBitableConfig();
  const record =
    (await findMeetingRecordByMeetingId(config, meetingId)) ||
    (await upsertMeetingWaitingRecord(config, {
      meetingId,
      topic: asString(note.title) || asString(event.title) || '未命名会议',
    }));

  if (!verbatimToken) {
    await setMeetingProcessStatus(config, record.recordId, FEISHU_PROCESS_STATUS.failed, {
      '错误信息': '纪要生成事件缺少 verbatim_token，不能使用智能纪要正文 fallback',
    });
    throw new Error('纪要生成事件缺少 verbatim_token，不能使用智能纪要正文 fallback');
  }

  try {
    await setMeetingProcessStatus(config, record.recordId, FEISHU_PROCESS_STATUS.fetchingTranscript);
    const transcript = await fetchTranscriptByDocToken(verbatimToken);

    await setMeetingProcessStatus(config, record.recordId, FEISHU_PROCESS_STATUS.analyzing, {
      '会议文字稿': transcript,
      '错误信息': '',
    });

    const analysis = await analyzeMeetingText(transcript);
    const reportUrl = `${getProjectPublicUrl()}/report?recordId=${record.recordId}`;

    await setMeetingProcessStatus(config, record.recordId, FEISHU_PROCESS_STATUS.completed, {
      '会议文字稿': transcript,
      '分析摘要': analysis.summary,
      '报告链接': reportUrl,
      'JSON数据': JSON.stringify(analysis),
      '错误信息': '',
    });

    console.info('[Feishu Webhook] 转录稿分析完成:', {
      meetingId,
      recordId: record.recordId,
      reportUrl,
    });
  } catch (error) {
    await setMeetingProcessStatus(config, record.recordId, FEISHU_PROCESS_STATUS.failed, {
      '错误信息': error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
