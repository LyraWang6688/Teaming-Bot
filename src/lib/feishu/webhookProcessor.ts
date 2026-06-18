/**
 * 飞书 Webhook 异步处理骨架
 *
 * Webhook 请求只负责验收事件并快速返回，耗时工作在后台异步执行。
 * 生产部署时建议将 processedEventIds、重试调度和任务状态迁移到数据库/队列，
 * 避免服务重启后丢失去重信息。
 */

import { analyzeMeetingText } from '@/services/analysisService';
import { getFeishuBitableConfig, getProjectPublicUrl } from './config';
import {
  type FeishuMeetingRecord,
  findMeetingRecordByMeetingId,
  listMeetingRecordsByStatuses,
  setMeetingProcessStatus,
  upsertMeetingWaitingRecord,
} from './bitableOpenApi';
import { callFeishuUserOpenApi, FeishuOpenApiError } from './openapi';
import { logFeishuMonitor, toErrorContext } from './monitor';
import { FEISHU_ACTIVE_PROCESS_STATUSES, FEISHU_PROCESS_STATUS } from './status';
import { fetchTranscriptByMinuteToken } from './transcript';

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

type MeetingEndedSource = {
  eventType?: string;
  meetingId: string;
  attempt: number;
  title: string;
  startTime?: number;
  endTime: number;
  organizer?: string;
  organizerSource?: 'owner' | 'host_user' | 'operator' | 'missing';
  recordId?: string;
};

type MinutesSearchItem = {
  token?: string;
  display_info?: string;
  meta_data?: {
    app_link?: string;
    avatar?: string;
    description?: string;
  };
};

type MinutesSearchResult = {
  items?: MinutesSearchItem[];
  has_more?: boolean;
  page_token?: string;
};

const processedEventIds = new Set<string>();
const processingMeetingIds = new Map<string, number>();
const scheduledMeetingRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

const MINUTE_SEARCH_WINDOWS_MINUTES = [2, 3, 4, 5] as const;
const PROCESSING_LOCK_TTL_MS = 20 * 60_000;
const ANALYSIS_MAX_ATTEMPTS = 3;
const ANALYSIS_RETRY_DELAY_MS = 3_000;
const ENABLE_STARTUP_RECOVERY =
  process.env.FEISHU_ENABLE_STARTUP_RECOVERY !== 'false';
const STARTUP_RECOVERY_LIMIT = 50;

let hasStartedRecoveryScan = false;

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

function scheduleBackgroundTask(task: () => Promise<void>, delayMs = 0) {
  setTimeout(() => {
    task().catch((error) => {
      logFeishuMonitor('error', 'background_task_failed', toErrorContext(error));
    });
  }, delayMs);
}

function getMeetingUserOpenId(value: unknown): string | undefined {
  const user = asRecord(value);
  const id = user.id;
  if (typeof id === 'string') {
    return asString(id);
  }

  return asString(asRecord(id).open_id);
}

function getOrganizerInfo(meeting: Record<string, unknown>, event: Record<string, unknown>) {
  const owner = getMeetingUserOpenId(meeting.owner);
  if (owner) {
    return {
      organizer: owner,
      organizerSource: 'owner' as const,
    };
  }

  const hostUser = getMeetingUserOpenId(meeting.host_user);
  if (hostUser) {
    return {
      organizer: hostUser,
      organizerSource: 'host_user' as const,
    };
  }

  const operator = getMeetingUserOpenId(event.operator);
  if (operator) {
    return {
      organizer: operator,
      organizerSource: 'operator' as const,
    };
  }

  return {
    organizer: undefined,
    organizerSource: 'missing' as const,
  };
}

function getSearchWindowMinute(attempt: number): number {
  return MINUTE_SEARCH_WINDOWS_MINUTES[attempt] ?? MINUTE_SEARCH_WINDOWS_MINUTES.at(-1)!;
}

function getSearchTargetTime(endTime: number, attempt: number): number {
  return endTime + getSearchWindowMinute(attempt) * 60_000;
}

function toIsoTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
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
    logFeishuMonitor('info', 'webhook_duplicate_ignored', {
      eventId,
      eventType,
    });
    return { accepted: true, duplicate: true, eventId, eventType };
  }

  processedEventIds.add(eventId);
  logFeishuMonitor('info', 'webhook_event_enqueued', {
    eventId,
    eventType,
  });

  scheduleBackgroundTask(async () => {
    await processFeishuWebhookEvent(envelope);
  });

  return { accepted: true, duplicate: false, eventId, eventType };
}

async function processFeishuWebhookEvent(envelope: FeishuWebhookEnvelope) {
  const eventType = getEventType(envelope);
  const eventId = getEventId(envelope);

  switch (eventType) {
    case 'vc.meeting.participant_meeting_ended_v1':
      await processParticipantMeetingEndedEvent(envelope);
      return;

    default:
      logFeishuMonitor('info', 'webhook_event_ignored', {
        eventId,
        eventType,
      });
  }
}

async function processParticipantMeetingEndedEvent(envelope: FeishuWebhookEnvelope) {
  const event = envelope.event || {};
  const meeting = asRecord(event.meeting);
  const meetingId = asString(meeting.id);
  const title = asString(meeting.topic);
  const startTime = toTimestamp(meeting.start_time);
  const endTime = toTimestamp(meeting.end_time);
  const eventType = getEventType(envelope);
  const eventId = getEventId(envelope);
  const { organizer, organizerSource } = getOrganizerInfo(meeting, asRecord(event));

  logFeishuMonitor('info', 'meeting_ended_event_received', {
    eventId,
    eventType,
    meetingId,
    title,
    organizer,
    organizerSource,
  });

  if (!meetingId) {
    throw new Error('会议结束事件缺少 meeting.id');
  }

  if (!title) {
    throw new Error('会议结束事件缺少 meeting.topic');
  }

  if (!endTime) {
    throw new Error('会议结束事件缺少 meeting.end_time');
  }

  await processParticipantMeetingEndedAttempt({
    eventType,
    meetingId,
    attempt: 0,
    title,
    startTime,
    endTime,
    organizer,
    organizerSource,
  });
}

async function processParticipantMeetingEndedAttempt(context: MeetingEndedSource) {
  const config = getFeishuBitableConfig();
  const existing = await findMeetingRecordByMeetingId(config, context.meetingId);
  const skipReason = existing ? getSkipReason(existing) : null;

  if (skipReason) {
    logFeishuMonitor('info', 'meeting_pipeline_skipped', {
      meetingId: context.meetingId,
      recordId: existing?.recordId,
      eventType: context.eventType,
      reason: skipReason,
    });
    return;
  }

  const record = await upsertMeetingWaitingRecord(config, {
    meetingId: context.meetingId,
    topic: context.title,
    startTime: context.startTime,
    endTime: context.endTime,
    organizer: context.organizer,
  });
  context.recordId = record.recordId;

  logFeishuMonitor('info', 'meeting_record_upserted', {
    meetingId: context.meetingId,
    recordId: record.recordId,
    attempt: context.attempt,
    organizer: context.organizer,
    organizerSource: context.organizerSource,
  });

  if (!context.organizer) {
    await setMeetingProcessStatus(config, record.recordId, FEISHU_PROCESS_STATUS.failed, {
      '错误信息': '会议结束事件中缺少组织者 open_id，无法按 owner_ids 规则搜索妙记。',
    });
    logFeishuMonitor('error', 'meeting_pipeline_failed_missing_organizer', {
      meetingId: context.meetingId,
      recordId: record.recordId,
      organizerSource: context.organizerSource,
    });
    return;
  }

  if (Date.now() < getSearchTargetTime(context.endTime, context.attempt)) {
    await scheduleCurrentMeetingAttempt(
      context,
      record.recordId,
      `会议已结束，等待会议结束后第 ${getSearchWindowMinute(context.attempt)} 分钟开始搜索妙记。`
    );
    return;
  }

  if (hasActiveProcessingLock(context.meetingId)) {
    logFeishuMonitor('warn', 'meeting_pipeline_locked', {
      meetingId: context.meetingId,
      recordId: record.recordId,
      eventType: context.eventType,
      attempt: context.attempt,
    });
    return;
  }

  clearScheduledMeetingRetry(context.meetingId);
  processingMeetingIds.set(context.meetingId, Date.now());

  try {
    logFeishuMonitor('info', 'minutes_search_started', {
      meetingId: context.meetingId,
      recordId: record.recordId,
      attempt: context.attempt,
      organizer: context.organizer,
      organizerSource: context.organizerSource,
      title: context.title,
      searchWindowMinute: getSearchWindowMinute(context.attempt),
    });
    const searchResult = await searchMeetingMinutes(context);
    const matchedCount = searchResult.items?.length || 0;
    const minuteToken = asString(searchResult.items?.[0]?.token);
    logFeishuMonitor('info', 'minutes_search_finished', {
      meetingId: context.meetingId,
      recordId: record.recordId,
      attempt: context.attempt,
      matchedCount,
      minuteToken,
    });

    if (!minuteToken) {
      await scheduleNextMeetingRetry(
        context,
        record.recordId,
        `第 ${getSearchWindowMinute(context.attempt)} 分钟的搜索窗口内未找到匹配妙记。`,
        '在会议结束后 5 分钟内仍未找到匹配妙记，请确认会议标题是否可检索，并请组织者共享妙记及导出权限。'
      );
      return;
    }

    const latestRecord = (await findMeetingRecordByMeetingId(config, context.meetingId)) || record;
    const latestSkipReason = getSkipReason(latestRecord);
    if (latestSkipReason) {
      logFeishuMonitor('info', 'meeting_pipeline_skipped_after_refresh', {
        meetingId: context.meetingId,
        recordId: latestRecord.recordId,
        eventType: context.eventType,
        reason: latestSkipReason,
      });
      return;
    }

    await setMeetingProcessStatus(
      config,
      latestRecord.recordId,
      FEISHU_PROCESS_STATUS.fetchingTranscript,
      {
        '错误信息': '',
      }
    );
    logFeishuMonitor('info', 'transcript_export_started', {
      meetingId: context.meetingId,
      recordId: latestRecord.recordId,
      minuteToken,
    });
    const transcript = await fetchTranscriptByMinuteToken(minuteToken);
    logFeishuMonitor('info', 'transcript_export_finished', {
      meetingId: context.meetingId,
      recordId: latestRecord.recordId,
      minuteToken,
      transcriptLength: transcript.length,
    });

    await completeMeetingAnalysis(config, latestRecord, transcript, minuteToken, context);
  } catch (error) {
    const handled = await handleRetryableMeetingError(context, error, record.recordId);
    if (handled) {
      return;
    }

    await setMeetingProcessStatus(config, record.recordId, FEISHU_PROCESS_STATUS.failed, {
      '错误信息': toBusinessErrorMessage(error),
    });
    logFeishuMonitor('error', 'meeting_pipeline_failed', {
      meetingId: context.meetingId,
      recordId: record.recordId,
      attempt: context.attempt,
      organizer: context.organizer,
      organizerSource: context.organizerSource,
      ...toErrorContext(error),
    });
    throw error;
  } finally {
    processingMeetingIds.delete(context.meetingId);
  }
}

async function completeMeetingAnalysis(
  config: ReturnType<typeof getFeishuBitableConfig>,
  record: FeishuMeetingRecord,
  transcript: string,
  minuteToken: string,
  context: MeetingEndedSource
) {
  await setMeetingProcessStatus(config, record.recordId, FEISHU_PROCESS_STATUS.analyzing, {
    '会议文字稿': transcript,
    '错误信息': '',
  });

  const analysis = await analyzeMeetingTranscriptWithRetries(transcript, {
    meetingId: context.meetingId,
    recordId: record.recordId,
    minuteToken,
  });
  const reportUrl = `${getProjectPublicUrl()}/report?recordId=${record.recordId}`;

  await setMeetingProcessStatus(config, record.recordId, FEISHU_PROCESS_STATUS.completed, {
    '会议文字稿': transcript,
    '分析摘要': analysis.summary,
    '报告链接': reportUrl,
    'JSON数据': JSON.stringify(analysis),
    '错误信息': '',
  });

  logFeishuMonitor('info', 'meeting_pipeline_completed', {
    meetingId: context.meetingId,
    minuteToken,
    recordId: record.recordId,
    reportUrl,
  });
}

async function analyzeMeetingTranscriptWithRetries(
  transcript: string,
  context: { meetingId: string; recordId: string; minuteToken?: string }
) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= ANALYSIS_MAX_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    logFeishuMonitor('info', 'analysis_started', {
      ...context,
      attempt,
      maxAttempts: ANALYSIS_MAX_ATTEMPTS,
    });

    try {
      const analysis = await analyzeMeetingText(transcript);
      logFeishuMonitor('info', 'analysis_succeeded', {
        ...context,
        attempt,
        durationMs: Date.now() - startedAt,
      });
      return analysis;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableAnalysisError(error);
      logFeishuMonitor(retryable ? 'warn' : 'error', 'analysis_failed', {
        ...context,
        attempt,
        durationMs: Date.now() - startedAt,
        retryable,
        ...toErrorContext(error),
      });

      if (!retryable || attempt >= ANALYSIS_MAX_ATTEMPTS) {
        break;
      }

      await sleep(ANALYSIS_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError;
}

async function searchMeetingMinutes(context: MeetingEndedSource): Promise<MinutesSearchResult> {
  return callFeishuUserOpenApi<MinutesSearchResult>(
    'POST',
    '/minutes/v1/minutes/search?user_id_type=open_id&page_size=10',
    {
      query: context.title,
      filter: {
        owner_ids: [context.organizer],
        create_time: {
          start_time: toIsoTime(context.endTime),
          end_time: toIsoTime(Date.now()),
        },
      },
    }
  );
}

function getSkipReason(record: FeishuMeetingRecord): string | null {
  const status = asString(record.processStatus);
  if (status === FEISHU_PROCESS_STATUS.completed) {
    return '会议已完成分析';
  }

  return null;
}

function isRetryableAnalysisError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  return (
    message.includes('http 429') ||
    message.includes('http 500') ||
    message.includes('http 502') ||
    message.includes('http 503') ||
    message.includes('http 504') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('fetch failed') ||
    message.includes('返回空内容')
  );
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clearScheduledMeetingRetry(meetingId: string) {
  const existingTimer = scheduledMeetingRetryTimers.get(meetingId);
  if (!existingTimer) {
    return;
  }

  clearTimeout(existingTimer);
  scheduledMeetingRetryTimers.delete(meetingId);
}

function hasActiveProcessingLock(meetingId: string): boolean {
  const startedAt = processingMeetingIds.get(meetingId);
  if (!startedAt) {
    return false;
  }

  if (startedAt + PROCESSING_LOCK_TTL_MS <= Date.now()) {
    processingMeetingIds.delete(meetingId);
    return false;
  }

  return true;
}

async function scheduleCurrentMeetingAttempt(
  context: MeetingEndedSource,
  recordId: string,
  reason: string
): Promise<boolean> {
  if (scheduledMeetingRetryTimers.has(context.meetingId)) {
    return true;
  }

  const delayMs = Math.max(getSearchTargetTime(context.endTime, context.attempt) - Date.now(), 0);
  const config = getFeishuBitableConfig();
  await setMeetingProcessStatus(config, recordId, FEISHU_PROCESS_STATUS.meetingEnded, {
    '错误信息': reason,
  });

  logFeishuMonitor('info', 'minutes_search_scheduled', {
    meetingId: context.meetingId,
    recordId,
    attempt: context.attempt,
    delayMs,
    reason,
  });

  const timer = setTimeout(() => {
    scheduledMeetingRetryTimers.delete(context.meetingId);
    scheduleBackgroundTask(async () => {
      await processParticipantMeetingEndedAttempt(context);
    });
  }, delayMs);

  scheduledMeetingRetryTimers.set(context.meetingId, timer);
  return true;
}

async function scheduleNextMeetingRetry(
  context: MeetingEndedSource,
  recordId: string,
  reason: string,
  finalFailureMessage: string
): Promise<boolean> {
  const nextAttempt = context.attempt + 1;
  if (nextAttempt >= MINUTE_SEARCH_WINDOWS_MINUTES.length) {
    const config = getFeishuBitableConfig();
    await setMeetingProcessStatus(config, recordId, FEISHU_PROCESS_STATUS.failed, {
      '错误信息': finalFailureMessage,
    });
    logFeishuMonitor('error', 'minutes_search_exhausted', {
      meetingId: context.meetingId,
      recordId,
      attempt: context.attempt,
      reason: finalFailureMessage,
    });
    return false;
  }

  if (scheduledMeetingRetryTimers.has(context.meetingId)) {
    return true;
  }

  const config = getFeishuBitableConfig();
  await setMeetingProcessStatus(config, recordId, FEISHU_PROCESS_STATUS.meetingEnded, {
    '错误信息': `${reason}；将在会议结束后第 ${getSearchWindowMinute(nextAttempt)} 分钟再次搜索妙记。`,
  });

  const nextContext = {
    ...context,
    attempt: nextAttempt,
  };
  const delayMs = Math.max(getSearchTargetTime(nextContext.endTime, nextContext.attempt) - Date.now(), 0);

  logFeishuMonitor('warn', 'minutes_search_rescheduled', {
    meetingId: context.meetingId,
    recordId,
    nextAttempt,
    delayMs,
    reason,
  });

  const timer = setTimeout(() => {
    scheduledMeetingRetryTimers.delete(context.meetingId);
    scheduleBackgroundTask(async () => {
      await processParticipantMeetingEndedAttempt(nextContext);
    });
  }, delayMs);

  scheduledMeetingRetryTimers.set(context.meetingId, timer);
  return true;
}

function isRetryableMeetingError(error: unknown): boolean {
  if (!(error instanceof FeishuOpenApiError)) {
    return false;
  }

  if (error.statusCode === 429 || (error.statusCode && error.statusCode >= 500)) {
    return true;
  }

  return (
    error.code === 2091003 ||
    error.code === 2095001 ||
    error.code === 2095002 ||
    error.code === 2095101
  );
}

function toBusinessErrorMessage(error: unknown): string {
  if (error instanceof FeishuOpenApiError) {
    if (error.code === 2091005) {
      return '未获得该篇妙记的导出权限，请联系组织者共享妙记并授予导出文字稿权限。';
    }

    if (error.code === 2091002) {
      return '找到的妙记已不可用，请稍后重试或联系组织者确认妙记状态。';
    }

    if (error.code === 2094011 || error.code === 2094012) {
      return '当前用户授权已失效，请重新完成飞书授权后再试。';
    }
  }

  return error instanceof Error ? error.message : String(error);
}

async function handleRetryableMeetingError(
  context: MeetingEndedSource,
  error: unknown,
  recordId: string
): Promise<boolean> {
  if (!isRetryableMeetingError(error)) {
    return false;
  }

  const interimReason =
    error instanceof FeishuOpenApiError && error.code === 2091003
      ? `已找到妙记，但第 ${getSearchWindowMinute(context.attempt)} 分钟的搜索窗口内文字稿仍未就绪。`
      : `第 ${getSearchWindowMinute(context.attempt)} 分钟的搜索窗口内调用飞书接口失败。`;
  const finalFailureMessage =
    error instanceof FeishuOpenApiError && error.code === 2091003
      ? '已找到妙记，但在会议结束后 5 分钟内文字稿仍未就绪，请稍后重试或联系组织者确认妙记转写状态。'
      : '飞书接口在搜索妙记或导出文字稿时持续返回临时错误，请稍后重试。';

  logFeishuMonitor('warn', 'meeting_pipeline_retryable_error', {
    meetingId: context.meetingId,
    recordId,
    attempt: context.attempt,
    retryType:
      error instanceof FeishuOpenApiError && error.code === 2091003
        ? 'minute_not_ready'
        : 'temporary_feishu_error',
    ...toErrorContext(error),
  });

  return scheduleNextMeetingRetry(context, recordId, interimReason, finalFailureMessage);
}

function buildRecoveryContext(record: FeishuMeetingRecord): MeetingEndedSource | null {
  const meetingId = asString(record.meetingId);
  const title = asString(record.topic);
  const organizer = asString(record.organizer);
  const endTime = toTimestamp(record.endTime);
  const startTime = toTimestamp(record.startTime);

  if (!meetingId || !title || !endTime) {
    return null;
  }

  return {
    meetingId,
    title,
    organizer,
    organizerSource: organizer ? 'owner' : 'missing',
    startTime,
    endTime,
    attempt: 0,
    recordId: record.recordId,
  };
}

async function resumeMeetingRecord(record: FeishuMeetingRecord) {
  const context = buildRecoveryContext(record);
  if (!context) {
    logFeishuMonitor('warn', 'startup_recovery_record_skipped', {
      recordId: record.recordId,
      reason: '缺少 meetingId/title/endTime',
      processStatus: record.processStatus,
    });
    return;
  }

  if (
    asString(record.processStatus) === FEISHU_PROCESS_STATUS.analyzing &&
    typeof record.transcript === 'string' &&
    record.transcript.trim()
  ) {
    const config = getFeishuBitableConfig();
    await completeMeetingAnalysis(
      config,
      record,
      record.transcript.trim(),
      'recovered-from-base',
      context
    );
    return;
  }

  await processParticipantMeetingEndedAttempt(context);
}

export async function recoverFeishuMeetingPipelinesOnStartup() {
  if (!ENABLE_STARTUP_RECOVERY || hasStartedRecoveryScan) {
    return;
  }

  hasStartedRecoveryScan = true;

  try {
    const config = getFeishuBitableConfig();
    const activeRecords = await listMeetingRecordsByStatuses(
      config,
      FEISHU_ACTIVE_PROCESS_STATUSES,
      STARTUP_RECOVERY_LIMIT
    );

    logFeishuMonitor('info', 'startup_recovery_scan_finished', {
      activeCount: activeRecords.length,
      statuses: FEISHU_ACTIVE_PROCESS_STATUSES,
    });

    for (const record of activeRecords) {
      scheduleBackgroundTask(async () => {
        logFeishuMonitor('info', 'startup_recovery_record_scheduled', {
          recordId: record.recordId,
          meetingId: record.meetingId,
          processStatus: record.processStatus,
        });
        await resumeMeetingRecord(record);
      });
    }
  } catch (error) {
    logFeishuMonitor('error', 'startup_recovery_scan_failed', toErrorContext(error));
  }
}
