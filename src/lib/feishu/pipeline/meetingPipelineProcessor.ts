/**
 * 飞书会议管线处理器
 *
 * 基于妙记生成事件（minutes.minute.generated_v1）触发分析流程
 * 事件接收后快速入队，耗时工作在后台异步执行。
 */

import { readFile } from 'node:fs/promises';
import { analyzeMeetingText } from '@/services/analysisService';
import { getProjectPublicUrl } from '../common/config';
import {
  createOrgTargetBitableAccess,
  createSelectedOrgTargetBitableAccess,
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
  updateMeetingPipelineTask,
  upsertMeetingPipelineTaskForMinuteGenerated,
} from './meetingPipelineTaskStore';
import { getOrgTargetContextById } from '../projects/projectConfigStore';
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
  recordId?: string;
  targetOrgTargetId?: string;
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
const DEBUG_ENV_PATH = '.dbg/feishu-event-missing.env';

// #region debug-point E:report-helper
async function reportFeishuPipelineDebug(hypothesisId: string, location: string, msg: string, data: Record<string, unknown>) {
  let debugServerUrl = 'http://127.0.0.1:7777/event';
  let debugSessionId = 'feishu-event-missing';
  try {
    const envContent = await readFile(DEBUG_ENV_PATH, 'utf8');
    debugServerUrl =
      envContent.match(/DEBUG_SERVER_URL=(.+)/)?.[1]?.trim() || debugServerUrl;
    debugSessionId =
      envContent.match(/DEBUG_SESSION_ID=(.+)/)?.[1]?.trim() || debugSessionId;
  } catch {}
  void fetch(debugServerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: debugSessionId,
      runId: 'pre-fix',
      hypothesisId,
      location,
      msg: `[DEBUG] ${msg}`,
      data,
      ts: Date.now(),
    }),
  }).catch(() => {});
}
// #endregion

function getMeetingPipelineKey(context: Pick<MinuteGeneratedSource, 'meetingId' | 'integration'>): string {
  return `${context.integration.id}:${context.meetingId}`;
}

function getTargetFromPayload(payload: Record<string, unknown>): string | undefined {
  const target = asRecord(payload.target);
  return asString(target.orgTargetId);
}

async function getMeetingBitableAccess(context: {
  integration: FeishuIntegrationContext;
  targetOrgTargetId?: string;
}): Promise<FeishuBitableAccess> {
  if (context.targetOrgTargetId) {
    const orgTarget = await getOrgTargetContextById(context.targetOrgTargetId);
    if (!orgTarget) {
      throw new Error('任务绑定的组织目标表配置不存在，无法继续处理。');
    }
    return createOrgTargetBitableAccess(context.integration, orgTarget);
  }

  return createSelectedOrgTargetBitableAccess(context.integration);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

function getMinuteGeneratedEventPayload(event: Record<string, unknown>) {
  const minute = asRecord(event.minute);
  const minuteSource = asRecord(event.minute_source || minute.minute_source);
  const sourceType = asString(minuteSource.source_type);
  const sourceEntityId = asString(minuteSource.source_entity_id);
  const meetingIdFromSource = sourceType === 'meeting' ? sourceEntityId : undefined;

  return {
    minuteSource,
    sourceType,
    minuteToken: asString(event.minute_token) || asString(minute.minute_token) || asString(minute.id),
    meetingId:
      meetingIdFromSource ||
      asString(event.meeting_id) ||
      asString(event.video_meeting_id) ||
      asString(minute.meeting_id) ||
      asString(minute.video_meeting_id),
  };
}

export async function enqueueFeishuEvent(
  envelope: FeishuEventEnvelope,
  integration: FeishuIntegrationContext
): Promise<EnqueueResult> {
  const eventId = getEventId(envelope);
  const eventType = getEventType(envelope);

  // #region debug-point C:enqueue-entry
  void reportFeishuPipelineDebug('C', 'meetingPipelineProcessor.ts:enqueueFeishuEvent', 'Pipeline enqueue received normalized envelope', {
    integrationId: integration.id,
    eventId: eventId || null,
    eventType: eventType || null,
    schema: envelope.schema || null,
    headerEventType: envelope.header?.event_type || null,
    hasEventPayload: Boolean(envelope.event),
  });
  logFeishuMonitor('info', 'debug_pipeline_enqueue_received', {
    integrationId: integration.id,
    eventId: eventId || null,
    eventType: eventType || null,
    schema: envelope.schema || null,
    headerEventType: envelope.header?.event_type || null,
    hasEventPayload: Boolean(envelope.event),
  });
  // #endregion

  if (!eventId) {
    // #region debug-point C:missing-event-id
    void reportFeishuPipelineDebug('C', 'meetingPipelineProcessor.ts:missingEventId', 'Normalized event missing event_id', {
      integrationId: integration.id,
      eventType: eventType || null,
      envelopeKeys: Object.keys(envelope),
      payloadKeys: Object.keys(envelope.event || {}).slice(0, 20),
    });
    logFeishuMonitor('warn', 'debug_pipeline_missing_event_id', {
      integrationId: integration.id,
      eventType: eventType || null,
      envelopeKeys: Object.keys(envelope),
      payloadKeys: Object.keys(envelope.event || {}).slice(0, 20),
    });
    // #endregion
    return { accepted: false, duplicate: false, eventType };
  }

  if (eventType !== 'minutes.minute.generated_v1') {
    // #region debug-point C:ignored-event-type
    void reportFeishuPipelineDebug('C', 'meetingPipelineProcessor.ts:ignoredEventType', 'Normalized event type was ignored by pipeline', {
      integrationId: integration.id,
      eventId,
      eventType: eventType || null,
    });
    logFeishuMonitor('info', 'debug_pipeline_ignored_event_type', {
      integrationId: integration.id,
      eventId,
      eventType: eventType || null,
    });
    // #endregion
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
  const {
    sourceType,
    minuteToken,
    meetingId,
  } = getMinuteGeneratedEventPayload(event);

  // #region debug-point C:minute-generated-normalized
  void reportFeishuPipelineDebug('C', 'meetingPipelineProcessor.ts:minuteGeneratedNormalized', 'Minute-generated event normalized', {
    integrationId: integration.id,
    eventId,
    eventType: eventType || null,
    sourceType: sourceType || null,
    meetingId: meetingId || null,
    minuteTokenPresent: Boolean(minuteToken),
  });
  logFeishuMonitor('info', 'debug_minute_generated_normalized', {
    integrationId: integration.id,
    eventId,
    eventType: eventType || null,
    sourceType: sourceType || null,
    meetingId: meetingId || null,
    minuteTokenPresent: Boolean(minuteToken),
  });
  // #endregion

  logFeishuMonitor('info', 'minute_generated_event_received', {
    integrationId: integration.id,
    eventId,
    eventType,
    sourceType,
    minuteToken,
    meetingId,
  });

  if (!minuteToken) {
    throw new Error('妙记生成事件缺少 minute_token');
  }

  if (!meetingId) {
    throw new Error('妙记生成事件缺少会议来源 source_entity_id');
  }

  const targetAccess = await createSelectedOrgTargetBitableAccess(integration);
  const targetSnapshot = targetAccess.orgTarget
    ? {
        projectId: targetAccess.orgTarget.projectId,
        orgTargetId: targetAccess.orgTarget.id,
        orgKey: targetAccess.orgTarget.orgKey,
        orgName: targetAccess.orgTarget.orgName,
        tableId: targetAccess.orgTarget.tableId,
      }
    : undefined;

  logFeishuMonitor('info', 'pipeline_target_bound', {
    integrationId: integration.id,
    eventId,
    eventType,
    minuteToken,
    meetingId,
    projectId: targetSnapshot?.projectId || null,
    orgTargetId: targetSnapshot?.orgTargetId || null,
    orgKey: targetSnapshot?.orgKey || null,
    orgName: targetSnapshot?.orgName || null,
    tableId: targetSnapshot?.tableId || null,
  });

  const taskResult = await upsertMeetingPipelineTaskForMinuteGenerated({
    integration,
    eventId,
    eventType,
    minuteToken,
    meetingId,
    target: targetSnapshot,
  });

  if (taskResult.duplicate) {
    logFeishuMonitor('info', 'meeting_pipeline_task_duplicate_ignored', {
      integrationId: integration.id,
      taskId: taskResult.task.id,
      minuteToken,
      eventId,
      eventType,
      projectId: targetSnapshot?.projectId || null,
      orgTargetId: targetSnapshot?.orgTargetId || null,
      orgName: targetSnapshot?.orgName || null,
    });
  } else {
    logFeishuMonitor('info', 'meeting_pipeline_task_enqueued', {
      integrationId: integration.id,
      taskId: taskResult.task.id,
      minuteToken,
      eventId,
      eventType,
      created: taskResult.created,
      projectId: targetSnapshot?.projectId || null,
      orgTargetId: targetSnapshot?.orgTargetId || null,
      orgName: targetSnapshot?.orgName || null,
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
  const config = await getMeetingBitableAccess(context);
  const targetContext = {
    projectId: config.orgTarget?.projectId || null,
    orgTargetId: config.orgTarget?.id || null,
    orgKey: config.orgTarget?.orgKey || null,
    orgName: config.orgTarget?.orgName || null,
    tableId: config.orgTarget?.tableId || config.tableId,
  };

  logFeishuMonitor('info', 'meeting_pipeline_target_resolved', {
    integrationId: context.integration.id,
    taskId: context.taskId,
    meetingId: context.meetingId,
    minuteToken: context.minuteToken,
    ...targetContext,
  });

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
      ...targetContext,
    });
    return;
  }

  const record = await ensureMinuteRecord(config, context, existing);
  context.recordId = record.recordId;

  if (context.taskId) {
    await updateMeetingPipelineTask(context.taskId, {
      baseRecordId: record.recordId,
    });
  }

  logFeishuMonitor('info', 'meeting_record_upserted', {
    meetingId: context.meetingId,
    minuteToken: context.minuteToken,
    recordId: record.recordId,
    attempt: context.attempt,
    ...targetContext,
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
  const targetContext = {
    projectId: config.orgTarget?.projectId || null,
    orgTargetId: config.orgTarget?.id || null,
    orgKey: config.orgTarget?.orgKey || null,
    orgName: config.orgTarget?.orgName || null,
    tableId: config.orgTarget?.tableId || config.tableId,
  };

  if (context.taskId) {
    await updateMeetingPipelineTask(context.taskId, {
      currentStage: FEISHU_PROCESS_STATUS.analyzing,
      status: 'running',
      attemptCount: context.attempt,
      minuteToken,
    });
  }
  logFeishuMonitor('info', 'base_record_transcript_write_started', {
    meetingId: context.meetingId,
    minuteToken,
    recordId: record.recordId,
    transcriptLength: transcript.length,
    ...targetContext,
  });

  await setMeetingProcessStatus(config, record.recordId, FEISHU_PROCESS_STATUS.analyzing, {
    '会议文字稿': transcript,
    '错误信息': '',
  });
  logFeishuMonitor('info', 'base_record_transcript_write_succeeded', {
    meetingId: context.meetingId,
    minuteToken,
    recordId: record.recordId,
    transcriptLength: transcript.length,
    ...targetContext,
  });

  const analysis = await analyzeMeetingTranscriptWithRetries(transcript, {
    meetingId: context.meetingId,
    recordId: record.recordId,
    minuteToken,
  });
  const reportUrl = new URL('/report', getProjectPublicUrl());
  reportUrl.searchParams.set('recordId', record.recordId);
  reportUrl.searchParams.set('integrationId', context.integration.id);
  if (config.orgTarget?.id) {
    reportUrl.searchParams.set('orgTargetId', config.orgTarget.id);
  }
  const reportLinkText = `会议报告 ${context.meetingId}`;

  logFeishuMonitor('info', 'base_record_analysis_write_started', {
    meetingId: context.meetingId,
    minuteToken,
    recordId: record.recordId,
    reportUrl: reportUrl.toString(),
    ...targetContext,
  });

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
  logFeishuMonitor('info', 'base_record_analysis_write_succeeded', {
    meetingId: context.meetingId,
    minuteToken,
    recordId: record.recordId,
    reportUrl: reportUrl.toString(),
    ...targetContext,
  });

  logFeishuMonitor('info', 'meeting_pipeline_completed', {
    meetingId: context.meetingId,
    minuteToken,
    recordId: record.recordId,
    reportUrl: reportUrl.toString(),
    ...targetContext,
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
  context: Pick<MinuteGeneratedSource, 'meetingId' | 'minuteToken' | 'recordId'>,
  existing: FeishuMeetingRecord | null
): Promise<FeishuMeetingRecord> {
  if (!existing) {
    return upsertMeetingWaitingRecord(config, {
      meetingId: context.meetingId,
    });
  }

  const fields: Record<string, unknown> = {
    '会议ID': context.meetingId,
    '处理状态': FEISHU_PROCESS_STATUS.minuteGenerated,
  };

  await updateMeetingRecordFields(config, existing.recordId, fields);

  return {
    ...existing,
    meetingId: context.meetingId,
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
  taskId?: string,
  targetOrgTargetId?: string
): MinuteGeneratedSource | null {
  const meetingId = asString(record.meetingId);

  if (!meetingId) {
    return null;
  }

  return {
    integration,
    taskId,
    meetingId,
    minuteToken: '',
    attempt: 0,
    recordId: record.recordId,
    targetOrgTargetId,
  };
}

async function resumeMeetingRecord(
  record: FeishuMeetingRecord,
  integration: FeishuIntegrationContext,
  taskId?: string,
  targetOrgTargetId?: string
) {
  const context = buildRecoveryContext(record, integration, taskId, targetOrgTargetId);
  if (!context) {
    logFeishuMonitor('warn', 'startup_recovery_record_skipped', {
      recordId: record.recordId,
      reason: '缺少 meetingId',
      processStatus: record.processStatus,
    });
    return;
  }

  if (
    asString(record.processStatus) === FEISHU_PROCESS_STATUS.analyzing &&
    typeof record.transcript === 'string' &&
    record.transcript.trim()
  ) {
    const config = await getMeetingBitableAccess(context);
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

function buildRecoveryContextFromTask(
  task: NonNullable<Awaited<ReturnType<typeof getMeetingPipelineTaskById>>>,
  integration: FeishuIntegrationContext
): MinuteGeneratedSource | null {
  return {
    integration,
    taskId: task.id,
    eventType: task.eventType || undefined,
    meetingId: task.feishuMeetingId,
    minuteToken: task.minuteToken || '',
    attempt: task.attemptCount,
    recordId: task.baseRecordId || undefined,
    targetOrgTargetId: getTargetFromPayload(task.payload),
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
      const config = await getMeetingBitableAccess({
        integration,
        targetOrgTargetId: getTargetFromPayload(task.payload),
      });
      const record = await getBitableRecord(config, task.baseRecordId);
      await resumeMeetingRecord(record, integration, task.id, getTargetFromPayload(task.payload));
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
