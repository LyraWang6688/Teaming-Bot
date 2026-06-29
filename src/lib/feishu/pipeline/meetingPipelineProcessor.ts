/**
 * 飞书会议管线处理器
 *
 * 基于妙记生成事件（minutes.minute.generated_v1）触发分析流程
 * 事件接收后快速入队，耗时工作在后台异步执行。
 */

import { analyzeMeetingText } from '@/services/analysisService';
import { getProjectPublicUrl } from '../common/config';
import {
  createIntegrationBitableAccess,
  type FeishuBitableAccess,
  type FeishuMeetingRecord,
  getBitableRecord,
  findMeetingRecordByMeetingId,
  setMeetingProcessStatus,
  updateMeetingRecordFields,
  upsertMeetingWaitingRecord,
} from '../bitable/bitableOpenApi';
import {
  type FeishuIntegrationContext,
  getFeishuIntegrationContextById,
} from '../integration/integrationStore';
import {
  completeMeetingPipelineTask,
  failMeetingPipelineTask,
  getMeetingPipelineTaskByEventId,
  getMeetingPipelineTaskById,
  listRecoverableMeetingPipelineTasks,
  markMeetingPipelineTaskRunning,
  type MeetingPipelineTaskPayload,
  updateMeetingPipelineTask,
  upsertMeetingPipelineTaskForMinuteGenerated,
} from './meetingPipelineTaskStore';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { FeishuOpenApiError } from '../common/openapi';
import { FEISHU_PROCESS_STATUS } from './status';
import { fetchTranscriptByMinuteToken } from '../minutes/transcript';

type FeishuEventHeader = {
  event_id?: string;
  event_type?: string;
  create_time?: string;
  token?: string;
};

export type FeishuEventEnvelope = {
  schema?: string;
  type?: string;
  challenge?: string;
  token?: string;
  header?: FeishuEventHeader;
  event?: Record<string, unknown>;
};

type EnqueueResult = {
  accepted: boolean;
  duplicate: boolean;
  eventId?: string;
  eventType?: string;
  taskId?: string;
  executionMode?: 'worker';
};

type MinuteGeneratedSource = {
  integration: FeishuIntegrationContext;
  taskId?: string;
  eventType?: string;
  meetingId: string;
  minuteToken: string;
  attempt: number;
  title: string;
  startTime?: number;
  endTime?: number;
  organizer?: string;
  organizerSource?: 'owner' | 'host' | 'creator' | 'missing';
  recordId?: string;
};

const processingMeetingIds = new Map<string, number>();

const PROCESSING_LOCK_TTL_MS = 20 * 60_000;
const ANALYSIS_MAX_ATTEMPTS = 3;
const ANALYSIS_RETRY_DELAY_MS = 3_000;
const TRANSCRIPT_MAX_ATTEMPTS = 3;
const TRANSCRIPT_RETRY_DELAY_MS = 5_000;

const ENABLE_STARTUP_RECOVERY =
  process.env.FEISHU_ENABLE_STARTUP_RECOVERY !== 'false';
const STARTUP_RECOVERY_LIMIT = 50;

let hasStartedRecoveryScan = false;

function getMeetingPipelineKey(context: Pick<MinuteGeneratedSource, 'meetingId' | 'integration'>): string {
  return `${context.integration.id}:${context.meetingId}`;
}

function getMeetingBitableAccess(integration: FeishuIntegrationContext): FeishuBitableAccess {
  return createIntegrationBitableAccess(integration);
}

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

function getEventId(envelope: FeishuEventEnvelope): string | undefined {
  return envelope.header?.event_id || (envelope.event?.event_id as string | undefined);
}

function getEventType(envelope: FeishuEventEnvelope): string | undefined {
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

function getOrganizerInfo(minute: Record<string, unknown>) {
  const owner = getMeetingUserOpenId(minute.owner);
  if (owner) {
    return {
      organizer: owner,
      organizerSource: 'owner' as const,
    };
  }

  const host = getMeetingUserOpenId(minute.host);
  if (host) {
    return {
      organizer: host,
      organizerSource: 'host' as const,
    };
  }

  const creator = getMeetingUserOpenId(minute.creator);
  if (creator) {
    return {
      organizer: creator,
      organizerSource: 'creator' as const,
    };
  }

  return {
    organizer: undefined,
    organizerSource: 'missing' as const,
  };
}

export async function enqueueFeishuEvent(
  envelope: FeishuEventEnvelope,
  integration: FeishuIntegrationContext
): Promise<EnqueueResult> {
  const eventId = getEventId(envelope);
  const eventType = getEventType(envelope);

  if (!eventId) {
    return { accepted: false, duplicate: false, eventType };
  }

  if (eventType !== 'minutes.minute.generated_v1') {
    logFeishuMonitor('info', 'event_type_ignored', {
      integrationId: integration.id,
      eventId,
      eventType,
    });
    return { accepted: true, duplicate: false, eventId, eventType };
  }

  const existingByEventId = await getMeetingPipelineTaskByEventId(integration.id, eventId);
  if (existingByEventId) {
    logFeishuMonitor('info', 'event_duplicate_by_event_id_skipped', {
      integrationId: integration.id,
      eventId,
      eventType,
      taskId: existingByEventId.id,
      taskStatus: existingByEventId.status,
    });
    return {
      accepted: true,
      duplicate: true,
      eventId,
      eventType,
      taskId: existingByEventId.id,
      executionMode: 'worker',
    };
  }

  const event = envelope.event || {};
  const minute = asRecord(event.minute);
  const minuteToken = asString(minute.minute_token) || asString(minute.id);
  const title = asString(minute.topic) || asString(minute.title);
  const startTime = toTimestamp(minute.start_time) || toTimestamp(minute.create_time);
  const endTime = toTimestamp(minute.end_time);
  const meetingId = asString(minute.meeting_id) || asString(minute.video_meeting_id);
  const { organizer, organizerSource } = getOrganizerInfo(minute);

  logFeishuMonitor('info', 'minute_generated_event_received', {
    integrationId: integration.id,
    eventId,
    eventType,
    minuteToken,
    meetingId,
    title,
    organizer,
    organizerSource,
  });

  if (!minuteToken) {
    throw new Error('妙记生成事件缺少 minute_token');
  }

  if (!title) {
    throw new Error('妙记生成事件缺少 topic');
  }

  const taskResult = await upsertMeetingPipelineTaskForMinuteGenerated({
    integration,
    eventId,
    eventType,
    minuteToken,
    meetingId: meetingId || minuteToken,
    title,
    startTime,
    endTime,
    organizer,
    organizerSource,
  });

  if (taskResult.duplicate) {
    logFeishuMonitor('info', 'meeting_pipeline_task_duplicate_ignored', {
      integrationId: integration.id,
      taskId: taskResult.task.id,
      minuteToken,
      eventId,
      eventType,
    });
  } else {
    logFeishuMonitor('info', 'meeting_pipeline_task_enqueued', {
      integrationId: integration.id,
      taskId: taskResult.task.id,
      minuteToken,
      eventId,
      eventType,
      created: taskResult.created,
    });
  }

  return {
    accepted: true,
    duplicate: taskResult.duplicate,
    eventId,
    eventType,
    taskId: taskResult.task.id,
    executionMode: 'worker',
  };
}

async function processMinuteGeneratedAttempt(context: MinuteGeneratedSource) {
  const config = getMeetingBitableAccess(context.integration);
  const pipelineKey = getMeetingPipelineKey(context);
  const existing = await getMeetingRecordForContext(config, context);
  const skipReason = existing ? getSkipReason(existing) : null;

  if (skipReason) {
    logFeishuMonitor('info', 'meeting_pipeline_skipped', {
      meetingId: context.meetingId,
      minuteToken: context.minuteToken,
      recordId: existing?.recordId,
      eventType: context.eventType,
      reason: skipReason,
    });
    return;
  }

  const record = await ensureMinuteRecord(config, context, existing);
  context.recordId = record.recordId;

  if (context.taskId) {
    await updateMeetingPipelineTask(context.taskId, {
      baseRecordId: record.recordId,
      payload: {
        title: context.title,
        startTime: context.startTime,
        endTime: context.endTime,
        organizer: context.organizer,
        organizerSource: context.organizerSource,
      },
    });
  }

  logFeishuMonitor('info', 'meeting_record_upserted', {
    meetingId: context.meetingId,
    minuteToken: context.minuteToken,
    recordId: record.recordId,
    attempt: context.attempt,
    organizer: context.organizer,
    organizerSource: context.organizerSource,
  });

  if (hasActiveProcessingLock(pipelineKey)) {
    logFeishuMonitor('warn', 'meeting_pipeline_locked', {
      meetingId: context.meetingId,
      minuteToken: context.minuteToken,
      recordId: record.recordId,
      eventType: context.eventType,
      attempt: context.attempt,
    });
    return;
  }

  processingMeetingIds.set(pipelineKey, Date.now());

  try {
    if (context.taskId) {
      await markMeetingPipelineTaskRunning(context.taskId, {
        currentStage: FEISHU_PROCESS_STATUS.fetchingTranscript,
        attemptCount: context.attempt,
        minuteToken: context.minuteToken,
      });
    }
    await setMeetingProcessStatus(
      config,
      record.recordId,
      FEISHU_PROCESS_STATUS.fetchingTranscript,
      {
        '错误信息': '',
      }
    );

    logFeishuMonitor('info', 'transcript_export_started', {
      meetingId: context.meetingId,
      minuteToken: context.minuteToken,
      recordId: record.recordId,
    });

    const transcript = await fetchTranscriptWithRetries(context);

    logFeishuMonitor('info', 'transcript_export_finished', {
      meetingId: context.meetingId,
      minuteToken: context.minuteToken,
      recordId: record.recordId,
      transcriptLength: transcript.length,
    });

    const latestRecord = (await getMeetingRecordForContext(config, context)) || record;
    const latestSkipReason = getSkipReason(latestRecord);
    if (latestSkipReason) {
      logFeishuMonitor('info', 'meeting_pipeline_skipped_after_refresh', {
        meetingId: context.meetingId,
        minuteToken: context.minuteToken,
        recordId: latestRecord.recordId,
        eventType: context.eventType,
        reason: latestSkipReason,
      });
      return;
    }

    await completeMeetingAnalysis(config, latestRecord, transcript, context.minuteToken, context);
  } catch (error) {
    await setMeetingProcessStatus(config, record.recordId, FEISHU_PROCESS_STATUS.failed, {
      '错误信息': toBusinessErrorMessage(error),
    });
    logFeishuMonitor('error', 'meeting_pipeline_failed', {
      meetingId: context.meetingId,
      minuteToken: context.minuteToken,
      recordId: record.recordId,
      attempt: context.attempt,
      organizer: context.organizer,
      organizerSource: context.organizerSource,
      ...toErrorContext(error),
    });
    if (context.taskId) {
      await failMeetingPipelineTask(context.taskId, {
        currentStage: FEISHU_PROCESS_STATUS.fetchingTranscript,
        attemptCount: context.attempt,
        errorType: error instanceof Error ? error.name : 'MeetingPipelineFailed',
        errorMessage: toBusinessErrorMessage(error),
      });
    }
    throw error;
  } finally {
    processingMeetingIds.delete(pipelineKey);
  }
}

async function fetchTranscriptWithRetries(context: MinuteGeneratedSource): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= TRANSCRIPT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchTranscriptByMinuteToken(context.minuteToken, context.integration);
    } catch (error) {
      lastError = error;
      const retryable = isRetryableMinuteError(error);
      logFeishuMonitor('warn', 'transcript_export_retryable_error', {
        minuteToken: context.minuteToken,
        meetingId: context.meetingId,
        attempt,
        maxAttempts: TRANSCRIPT_MAX_ATTEMPTS,
        retryable,
        ...toErrorContext(error),
      });

      if (!retryable || attempt >= TRANSCRIPT_MAX_ATTEMPTS) {
        break;
      }

      await sleep(TRANSCRIPT_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError;
}

async function completeMeetingAnalysis(
  config: FeishuBitableAccess,
  record: FeishuMeetingRecord,
  transcript: string,
  minuteToken: string,
  context: MinuteGeneratedSource
) {
  if (context.taskId) {
    await updateMeetingPipelineTask(context.taskId, {
      currentStage: FEISHU_PROCESS_STATUS.analyzing,
      status: 'running',
      attemptCount: context.attempt,
      minuteToken,
    });
  }
  await setMeetingProcessStatus(config, record.recordId, FEISHU_PROCESS_STATUS.analyzing, {
    '会议文字稿': transcript,
    '错误信息': '',
  });

  const analysis = await analyzeMeetingTranscriptWithRetries(transcript, {
    meetingId: context.meetingId,
    recordId: record.recordId,
    minuteToken,
  });
  const reportUrl = new URL('/report', getProjectPublicUrl());
  reportUrl.searchParams.set('recordId', record.recordId);
  reportUrl.searchParams.set('integrationId', context.integration.id);
  const reportLinkText = context.title.trim() || record.topic || '会议报告';

  await setMeetingProcessStatus(config, record.recordId, FEISHU_PROCESS_STATUS.completed, {
    '会议文字稿': transcript,
    '分析摘要': analysis.summary,
    '报告链接': {
      text: reportLinkText,
      link: reportUrl.toString(),
    },
    'JSON数据': JSON.stringify(analysis),
    '错误信息': '',
  });

  logFeishuMonitor('info', 'meeting_pipeline_completed', {
    meetingId: context.meetingId,
    minuteToken,
    recordId: record.recordId,
    reportUrl: reportUrl.toString(),
  });
  if (context.taskId) {
    await completeMeetingPipelineTask(context.taskId, {
      baseRecordId: record.recordId,
      minuteToken,
      payload: {
        reportUrl: reportUrl.toString(),
      },
    });
  }
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

function getSkipReason(record: FeishuMeetingRecord): string | null {
  const status = asString(record.processStatus);
  if (status === FEISHU_PROCESS_STATUS.completed) {
    return '会议已完成分析';
  }

  return null;
}

async function getMeetingRecordForContext(
  config: FeishuBitableAccess,
  context: Pick<MinuteGeneratedSource, 'meetingId' | 'recordId'>
): Promise<FeishuMeetingRecord | null> {
  if (context.recordId) {
    try {
      const record = await getBitableRecord(config, context.recordId);
      const recordMeetingId = asString(record.meetingId);

      if (!recordMeetingId || recordMeetingId === context.meetingId) {
        return record;
      }

      logFeishuMonitor('warn', 'meeting_record_id_mismatch', {
        recordId: context.recordId,
        expectedMeetingId: context.meetingId,
        actualMeetingId: recordMeetingId,
      });
    } catch (error) {
      logFeishuMonitor('warn', 'meeting_record_id_reload_failed', {
        recordId: context.recordId,
        meetingId: context.meetingId,
        ...toErrorContext(error),
      });
    }
  }

  return findMeetingRecordByMeetingId(config, context.meetingId);
}

async function ensureMinuteRecord(
  config: FeishuBitableAccess,
  context: Pick<
    MinuteGeneratedSource,
    'meetingId' | 'minuteToken' | 'title' | 'startTime' | 'endTime' | 'organizer' | 'recordId'
  >,
  existing: FeishuMeetingRecord | null
): Promise<FeishuMeetingRecord> {
  if (!existing) {
    return upsertMeetingWaitingRecord(config, {
      meetingId: context.meetingId,
      topic: context.title,
      startTime: context.startTime,
      endTime: context.endTime,
      organizer: context.organizer,
    });
  }

  const fields: Record<string, unknown> = {
    '会议ID': context.meetingId,
    '会议主题': context.title,
    '处理状态': FEISHU_PROCESS_STATUS.minuteGenerated,
  };

  if (context.startTime) {
    fields['开始时间'] = context.startTime;
  }

  if (context.endTime) {
    fields['结束时间'] = context.endTime;
  }

  if (context.organizer) {
    fields['组织者'] = context.organizer;
  }

  await updateMeetingRecordFields(config, existing.recordId, fields);

  return {
    ...existing,
    meetingId: context.meetingId,
    topic: context.title,
    startTime: context.startTime ?? existing.startTime,
    endTime: context.endTime ?? existing.endTime,
    organizer: context.organizer ?? existing.organizer,
    processStatus: FEISHU_PROCESS_STATUS.minuteGenerated,
  };
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

function isRetryableMinuteError(error: unknown): boolean {
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

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasActiveProcessingLock(pipelineKey: string): boolean {
  const startedAt = processingMeetingIds.get(pipelineKey);
  if (!startedAt) {
    return false;
  }

  if (startedAt + PROCESSING_LOCK_TTL_MS <= Date.now()) {
    processingMeetingIds.delete(pipelineKey);
    return false;
  }

  return true;
}

function toBusinessErrorMessage(error: unknown): string {
  if (error instanceof FeishuOpenApiError) {
    if (error.code === 2091005) {
      return '未获得该篇妙记的导出权限，请检查妙记权限设置是否允许导出文字稿。';
    }

    if (error.code === 2091002) {
      return '找到的妙记已不可用，请稍后重试或联系组织者确认妙记状态。';
    }
  }

  return error instanceof Error ? error.message : String(error);
}

function buildRecoveryContext(
  record: FeishuMeetingRecord,
  integration: FeishuIntegrationContext,
  taskId?: string
): MinuteGeneratedSource | null {
  const meetingId = asString(record.meetingId);
  const title = asString(record.topic);
  const organizer = asString(record.organizer);
  const endTime = toTimestamp(record.endTime);
  const startTime = toTimestamp(record.startTime);

  if (!meetingId || !title) {
    return null;
  }

  return {
    integration,
    taskId,
    meetingId,
    minuteToken: '',
    title,
    organizer,
    organizerSource: organizer ? 'owner' : 'missing',
    startTime,
    endTime,
    attempt: 0,
    recordId: record.recordId,
  };
}

async function resumeMeetingRecord(
  record: FeishuMeetingRecord,
  integration: FeishuIntegrationContext,
  taskId?: string
) {
  const context = buildRecoveryContext(record, integration, taskId);
  if (!context) {
    logFeishuMonitor('warn', 'startup_recovery_record_skipped', {
      recordId: record.recordId,
      reason: '缺少 meetingId/title',
      processStatus: record.processStatus,
    });
    return;
  }

  if (
    asString(record.processStatus) === FEISHU_PROCESS_STATUS.analyzing &&
    typeof record.transcript === 'string' &&
    record.transcript.trim()
  ) {
    const config = getMeetingBitableAccess(integration);
    await completeMeetingAnalysis(
      config,
      record,
      record.transcript.trim(),
      'recovered-from-base',
      context
    );
    return;
  }

  await processMinuteGeneratedAttempt(context);
}

function buildTaskPayload(task: Awaited<ReturnType<typeof getMeetingPipelineTaskById>>) {
  return (task?.payload || {}) as MeetingPipelineTaskPayload;
}

function buildRecoveryContextFromTask(
  task: NonNullable<Awaited<ReturnType<typeof getMeetingPipelineTaskById>>>,
  integration: FeishuIntegrationContext
): MinuteGeneratedSource | null {
  const payload = buildTaskPayload(task);
  if (!payload.title) {
    return null;
  }

  return {
    integration,
    taskId: task.id,
    eventType: task.eventType || undefined,
    meetingId: task.feishuMeetingId,
    minuteToken: task.minuteToken || '',
    attempt: task.attemptCount,
    title: payload.title,
    startTime: typeof payload.startTime === 'number' ? payload.startTime : undefined,
    endTime: payload.endTime,
    organizer: payload.organizer,
    organizerSource:
      payload.organizerSource === 'owner' ||
      payload.organizerSource === 'host' ||
      payload.organizerSource === 'creator' ||
      payload.organizerSource === 'missing'
        ? payload.organizerSource
        : 'missing',
    recordId: task.baseRecordId || undefined,
  };
}

export async function runMeetingPipelineTask(taskId: string) {
  const task = await getMeetingPipelineTaskById(taskId);
  if (!task) {
    logFeishuMonitor('warn', 'meeting_pipeline_task_missing', {
      taskId,
    });
    return;
  }

  const integration = await getFeishuIntegrationContextById(task.integrationId);
  if (!integration) {
    await failMeetingPipelineTask(task.id, {
      currentStage: task.currentStage as typeof FEISHU_PROCESS_STATUS[keyof typeof FEISHU_PROCESS_STATUS],
      attemptCount: task.attemptCount,
      errorType: 'IntegrationMissing',
      errorMessage: '任务关联的飞书集成不存在或已删除。',
    });
    logFeishuMonitor('warn', 'meeting_pipeline_task_integration_missing', {
      taskId: task.id,
      integrationId: task.integrationId,
      meetingId: task.feishuMeetingId,
    });
    return;
  }

  if (task.baseRecordId) {
    try {
      const config = getMeetingBitableAccess(integration);
      const record = await getBitableRecord(config, task.baseRecordId);
      await resumeMeetingRecord(record, integration, task.id);
      return;
    } catch (error) {
      logFeishuMonitor('warn', 'meeting_pipeline_task_record_reload_failed', {
        taskId: task.id,
        integrationId: integration.id,
        baseRecordId: task.baseRecordId,
        ...toErrorContext(error),
      });
    }
  }

  const context = buildRecoveryContextFromTask(task, integration);
  if (!context) {
    await failMeetingPipelineTask(task.id, {
      currentStage: task.currentStage as typeof FEISHU_PROCESS_STATUS[keyof typeof FEISHU_PROCESS_STATUS],
      attemptCount: task.attemptCount,
      errorType: 'TaskPayloadIncomplete',
      errorMessage: '会议任务缺少恢复所需的 payload 信息。',
    });
    logFeishuMonitor('warn', 'meeting_pipeline_task_payload_incomplete', {
      taskId: task.id,
      integrationId: integration.id,
      meetingId: task.feishuMeetingId,
    });
    return;
  }

  await processMinuteGeneratedAttempt(context);
}

export async function recoverFeishuMeetingPipelinesOnStartup() {
  if (!ENABLE_STARTUP_RECOVERY || hasStartedRecoveryScan) {
    return;
  }

  hasStartedRecoveryScan = true;

  try {
    const tasks = await listRecoverableMeetingPipelineTasks(STARTUP_RECOVERY_LIMIT);

    logFeishuMonitor('info', 'startup_recovery_scan_finished', {
      mode: 'task_table',
      activeCount: tasks.length,
    });

    for (const task of tasks) {
      scheduleBackgroundTask(async () => {
        await runMeetingPipelineTask(task.id);
      });
    }
  } catch (error) {
    logFeishuMonitor('error', 'startup_recovery_scan_failed', toErrorContext(error));
  }
}
