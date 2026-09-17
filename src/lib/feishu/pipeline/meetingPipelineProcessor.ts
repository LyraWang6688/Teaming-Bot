/**
 * 飞书会议管线处理器
 *
 * 基于妙记生成事件（minutes.minute.generated_v1）触发分析流程
 * 事件接收后快速入队，耗时工作在后台异步执行。
 */

import { analyzeMeetingText } from '@/services/analysisService';
import {
  createOrgTargetBitableAccess,
  createSelectedOrgTargetBitableAccess,
  type FeishuBitableAccess,
  type FeishuMeetingRecord,
  getBitableRecord,
  findMeetingRecordByMeetingId,
  setMeetingProcessStatus,
} from '../bitable/bitableOpenApi';
import { syncMeetingRecordToBase, syncPartialFieldsToBase } from '../bitable/bitableSync';
import {
  type FeishuIntegrationContext,
  findActiveInitializedIntegrationByAuthorizedOpenId,
  getFeishuIntegrationContextById,
  getLatestFeishuAuthorizationContext,
  writeAuditLog,
} from '../integration/integrationStore';
import { isFeishuIntegrationActive } from '../integration/integrationActivationService';
import {
  completeMeetingPipelineTask,
  failMeetingPipelineTask,
  getMeetingPipelineTaskByEventId,
  getMeetingPipelineTaskById,
  listRecoverableMeetingPipelineTasks,
  markMeetingPipelineTaskRunning,
  scheduleMeetingPipelineTask,
  updateMeetingPipelineTask,
  upsertMeetingPipelineTaskForMinuteGenerated,
} from './meetingPipelineTaskStore';
import { getOrgTargetContextById } from '../projects/projectConfigStore';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { FeishuOpenApiError } from '../common/openapi';
import { FEISHU_PROCESS_STATUS } from './status';
import { fetchTranscriptByMinuteToken } from '../minutes/transcript';
import { sendMeetingReportNotification } from '../im/reportNotificationService';
import {
  fetchMeetingDetailsWithOrganizer,
} from '../meetings/meetingDetailsService';
import {
  MeetingDetailsError,
  type MeetingDetails,
} from '../meetings/meetingDetailsTypes';
import {
  getMeetingRecordByIntegrationAndMeeting,
  persistMeetingReport,
  updateMeetingRecordBaseReference,
  updateMeetingRecordStatus,
  updateMeetingRecordTranscript,
  upsertMeetingRecord,
} from '@/lib/reports/meetingReportStore';
import { buildPersistentReportUrl } from '@/lib/reports/reportUrl';

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
  meetingRecordId?: string;
  reportPublicId?: string;
  meetingDetails?: MeetingDetails | null;
  eventReceivedAt?: string;
  taskStartedAt?: string;
};

type MeetingAnalysisGateReason =
  | 'meeting_organizer_unresolved'
  | 'meeting_organizer_not_initialized'
  | 'meeting_organizer_owned_by_other_integration';

type MeetingAnalysisGateResult =
  | {
      allowed: true;
      organizerOpenId: string;
      currentAuthorizedOpenId: string | null;
      ownerIntegrationId: string;
    }
  | {
      allowed: false;
      reasonCode: MeetingAnalysisGateReason;
      reasonMessage: string;
      organizerOpenId: string | null;
      currentAuthorizedOpenId: string | null;
      ownerIntegrationId: string | null;
    };

const processingMeetingIds = new Map<string, number>();

const PROCESSING_LOCK_TTL_MS = 20 * 60_000;
const ANALYSIS_MAX_ATTEMPTS = 3;
const ANALYSIS_RETRY_DELAY_MS = 3_000;
const TRANSCRIPT_MAX_ATTEMPTS = 3;
const TRANSCRIPT_RETRY_DELAY_MS = 5_000;
const PIPELINE_MAX_ATTEMPTS = 3;
const PIPELINE_RETRY_DELAY_MS = 30_000;

const ENABLE_STARTUP_RECOVERY =
  process.env.FEISHU_ENABLE_STARTUP_RECOVERY !== 'false';
const STARTUP_RECOVERY_LIMIT = 50;

let hasStartedRecoveryScan = false;

function getMeetingPipelineKey(context: Pick<MinuteGeneratedSource, 'meetingId' | 'integration'>): string {
  return `${context.integration.id}:${context.meetingId}`;
}

function getTargetFromPayload(payload: Record<string, unknown>): string | undefined {
  const target = asRecord(payload.target);
  return asString(target.orgTargetId);
}

function getEventReceivedAtFromPayload(payload: Record<string, unknown>): string | undefined {
  const telemetry = asRecord(payload.telemetry);
  return asString(telemetry.eventReceivedAt);
}

function parseIsoTimestamp(value?: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildPipelineDurationContext(
  context: Pick<MinuteGeneratedSource, 'eventReceivedAt' | 'taskStartedAt'>,
  finishedAtMs: number
): Record<string, number> {
  const durations: Record<string, number> = {};
  const eventReceivedAtMs = parseIsoTimestamp(context.eventReceivedAt);
  const taskStartedAtMs = parseIsoTimestamp(context.taskStartedAt);

  if (eventReceivedAtMs !== null) {
    durations.eventToNowDurationMs = Math.max(finishedAtMs - eventReceivedAtMs, 0);
  }

  if (taskStartedAtMs !== null) {
    durations.processingDurationMs = Math.max(finishedAtMs - taskStartedAtMs, 0);
  }

  if (eventReceivedAtMs !== null && taskStartedAtMs !== null) {
    durations.queueDelayMs = Math.max(taskStartedAtMs - eventReceivedAtMs, 0);
  }

  return durations;
}

async function fetchMeetingDetailsWithFallback(
  context: MinuteGeneratedSource
): Promise<MeetingDetails | null> {
  try {
    return await fetchMeetingDetailsWithOrganizer(
      context.integration,
      context.meetingId,
      context.minuteToken
    );
  } catch (error) {
    if (
      error instanceof MeetingDetailsError &&
      (error.code === 'meeting_not_found' || error.code === 'meeting_access_denied')
    ) {
      logFeishuMonitor('warn', 'meeting_detail_unavailable', {
        userId: context.integration.userId,
        integrationId: context.integration.id,
        taskId: context.taskId,
        meetingId: context.meetingId,
        reasonCode: error.code,
      });
      return null;
    }

    throw error;
  }
}

async function resolveMeetingAnalysisGate(
  context: MinuteGeneratedSource,
  meetingDetails: MeetingDetails | null
): Promise<MeetingAnalysisGateResult> {
  const authorization = await getLatestFeishuAuthorizationContext(context.integration.id);
  const currentAuthorizedOpenId = authorization?.authorizedOpenId || null;
  const organizerOpenId = meetingDetails?.organizerOpenId || null;

  if (!organizerOpenId) {
    return {
      allowed: false,
      reasonCode: 'meeting_organizer_unresolved',
      reasonMessage: '妙记所有者 open_id 无法解析，跳过自动分析。',
      organizerOpenId: null,
      currentAuthorizedOpenId,
      ownerIntegrationId: null,
    };
  }

  const ownerIntegration = await findActiveInitializedIntegrationByAuthorizedOpenId({
    authorizedOpenId: organizerOpenId,
    selectedOrgTargetId: context.integration.selectedOrgTargetId,
  });

  if (!ownerIntegration) {
    return {
      allowed: false,
      reasonCode: 'meeting_organizer_not_initialized',
      reasonMessage: '会议创建人尚未完成当前组织下的飞书初始化配置，跳过自动分析。',
      organizerOpenId,
      currentAuthorizedOpenId,
      ownerIntegrationId: null,
    };
  }

  if (ownerIntegration.integrationId !== context.integration.id) {
    return {
      allowed: false,
      reasonCode: 'meeting_organizer_owned_by_other_integration',
      reasonMessage: '当前妙记事件来自参会人集成，不是会议创建人的当前活跃集成，跳过自动分析。',
      organizerOpenId,
      currentAuthorizedOpenId,
      ownerIntegrationId: ownerIntegration.integrationId,
    };
  }

  return {
    allowed: true,
    organizerOpenId,
    currentAuthorizedOpenId,
    ownerIntegrationId: ownerIntegration.integrationId,
  };
}

async function writeMeetingAnalysisGateAudit(
  context: MinuteGeneratedSource,
  gate: Extract<MeetingAnalysisGateResult, { allowed: false }>,
  phase: 'enqueue' | 'execute'
): Promise<void> {
  await writeAuditLog({
    userId: context.integration.userId,
    integrationId: context.integration.id,
    action: 'meeting.analysis.gated',
    result: 'skipped',
    summary: '会议未满足发起人初始化门槛，已跳过自动分析',
    metadata: {
      phase,
      meetingId: context.meetingId,
      minuteToken: context.minuteToken,
      eventType: context.eventType || null,
      taskId: context.taskId || null,
      reasonCode: gate.reasonCode,
      reasonMessage: gate.reasonMessage,
      organizerOpenId: gate.organizerOpenId,
      currentAuthorizedOpenId: gate.currentAuthorizedOpenId,
      ownerIntegrationId: gate.ownerIntegrationId,
      selectedOrgTargetId: context.integration.selectedOrgTargetId || null,
    },
  });
}

async function getMeetingBitableAccess(context: {
  integration: FeishuIntegrationContext;
  targetOrgTargetId?: string;
}): Promise<FeishuBitableAccess> {
  if (context.targetOrgTargetId) {
    const orgTarget = await getOrgTargetContextById(context.targetOrgTargetId);
    if (orgTarget) {
      return createOrgTargetBitableAccess(context.integration, orgTarget);
    }
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
  const eventReceivedAt = new Date().toISOString();

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
  const {
    sourceType,
    minuteToken,
    meetingId,
  } = getMinuteGeneratedEventPayload(event);

  logFeishuMonitor('info', 'minute_generated_event_received', {
    integrationId: integration.id,
    eventId,
    eventType,
    sourceType,
    minuteToken,
    meetingId,
    eventReceivedAt,
  });

  if (!minuteToken) {
    throw new Error('妙记生成事件缺少 minute_token');
  }

  if (!meetingId) {
    throw new Error('妙记生成事件缺少会议来源 source_entity_id');
  }

  const gateContext: MinuteGeneratedSource = {
    integration,
    eventType,
    meetingId,
    minuteToken,
    attempt: 0,
    eventReceivedAt,
  };
  const meetingDetails = await fetchMeetingDetailsWithFallback(gateContext);
  const analysisGate = await resolveMeetingAnalysisGate(gateContext, meetingDetails);

  if (!analysisGate.allowed) {
    await writeMeetingAnalysisGateAudit(gateContext, analysisGate, 'enqueue');

    // 门槛不通过：写 Supabase 留档（status=gated_skipped），不写 Base
    // 与 processMinuteGeneratedAttempt 中的 execute 阶段保持一致
    try {
      const gatedMeeting = await upsertMeetingRecord({
        integration,
        meetingId,
        minuteToken,
        projectId: null,
        orgTargetId: null,
        baseRecordId: null,
        details: meetingDetails,
      });
      await updateMeetingRecordStatus(gatedMeeting.id, {
        status: 'gated_skipped',
        errorType: analysisGate.reasonCode,
        errorMessage: analysisGate.reasonMessage,
      });
    } catch (error) {
      logFeishuMonitor('error', 'meeting_gated_supabase_persist_failed', {
        integrationId: integration.id,
        eventId,
        eventType,
        meetingId,
        minuteToken,
        reasonCode: analysisGate.reasonCode,
        ...toErrorContext(error),
      });
    }

    logFeishuMonitor('info', 'meeting_analysis_gated_before_enqueue', {
      integrationId: integration.id,
      eventId,
      eventType,
      meetingId,
      minuteToken,
      reasonCode: analysisGate.reasonCode,
      reasonMessage: analysisGate.reasonMessage,
      organizerOpenId: analysisGate.organizerOpenId,
      currentAuthorizedOpenId: analysisGate.currentAuthorizedOpenId,
      ownerIntegrationId: analysisGate.ownerIntegrationId,
    });
    return {
      accepted: true,
      duplicate: false,
      eventId,
      eventType,
    };
  }

  const targetAccess = await createSelectedOrgTargetBitableAccess(integration);
  const targetSnapshot = targetAccess.orgTarget
    ? {
        projectId: targetAccess.orgTarget.projectId,
        orgTargetId: targetAccess.orgTarget.id,
        orgKey: targetAccess.orgTarget.orgKey,
        orgName: targetAccess.orgTarget.orgName,
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
    tableId: targetAccess.tableId,
  });

  const taskResult = await upsertMeetingPipelineTaskForMinuteGenerated({
    integration,
    eventId,
    eventType,
    minuteToken,
    meetingId,
    eventReceivedAt,
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
  const meetingDetails = await fetchMeetingDetailsWithFallback(context);
  context.meetingDetails = meetingDetails;
  const analysisGate = await resolveMeetingAnalysisGate(context, meetingDetails);

  if (!analysisGate.allowed) {
    await writeMeetingAnalysisGateAudit(context, analysisGate, 'execute');

    // 门槛不通过：写 Supabase 留档（status=gated_skipped），不写 Base
    const gatedMeeting = await upsertMeetingRecord({
      integration: context.integration,
      meetingId: context.meetingId,
      minuteToken: context.minuteToken,
      projectId: null,
      orgTargetId: null,
      baseRecordId: null,
      details: meetingDetails,
    });
    await updateMeetingRecordStatus(gatedMeeting.id, {
      status: 'gated_skipped',
      errorType: analysisGate.reasonCode,
      errorMessage: analysisGate.reasonMessage,
    });

    if (context.taskId) {
      await completeMeetingPipelineTask(context.taskId, {
        payload: {
          skippedReason: analysisGate.reasonCode,
          skippedAt: new Date().toISOString(),
        },
      });
    }
    logFeishuMonitor('info', 'meeting_analysis_gated_during_execution', {
      integrationId: context.integration.id,
      taskId: context.taskId,
      meetingId: context.meetingId,
      minuteToken: context.minuteToken,
      meetingRecordId: gatedMeeting.id,
      reasonCode: analysisGate.reasonCode,
      reasonMessage: analysisGate.reasonMessage,
      organizerOpenId: analysisGate.organizerOpenId,
      currentAuthorizedOpenId: analysisGate.currentAuthorizedOpenId,
      ownerIntegrationId: analysisGate.ownerIntegrationId,
    });
    return;
  }

  const config = await getMeetingBitableAccess(context);
  const targetContext = {
    projectId: config.orgTarget?.projectId || null,
    orgTargetId: config.orgTarget?.id || null,
    orgKey: config.orgTarget?.orgKey || null,
    orgName: config.orgTarget?.orgName || null,
    tableId: config.tableId,
  };

  logFeishuMonitor('info', 'meeting_pipeline_target_resolved', {
    integrationId: context.integration.id,
    taskId: context.taskId,
    meetingId: context.meetingId,
    minuteToken: context.minuteToken,
    ...targetContext,
  });

  const persistedMeeting = await upsertMeetingRecord({
    integration: context.integration,
    meetingId: context.meetingId,
    minuteToken: context.minuteToken,
    projectId: config.orgTarget?.projectId || null,
    orgTargetId: config.orgTarget?.id || null,
    baseRecordId: context.recordId || null,
    details: meetingDetails,
  });
  context.meetingRecordId = persistedMeeting.id;
  context.reportPublicId = persistedMeeting.reportPublicId;

  logFeishuMonitor('info', 'meeting_record_upsert_succeeded', {
    userId: context.integration.userId,
    integrationId: context.integration.id,
    taskId: context.taskId,
    meetingId: context.meetingId,
    meetingRecordId: persistedMeeting.id,
    reportPublicId: persistedMeeting.reportPublicId,
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
  await updateMeetingRecordBaseReference(persistedMeeting.id, record.recordId);

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
    // Supabase 中间态仍写入，便于运维查询与任务恢复
    // Base 不写中间态：符合「Base 只展示终态（已完成/分析失败/写入失败）」原则
    await updateMeetingRecordStatus(persistedMeeting.id, {
      status: 'fetching_transcript',
      errorType: null,
      errorMessage: null,
    });

    logFeishuMonitor('info', 'transcript_export_started', {
      meetingId: context.meetingId,
      minuteToken: context.minuteToken,
      recordId: record.recordId,
    });

    const transcriptStartedAt = Date.now();
    const transcript = await fetchTranscriptWithRetries(context);
    await updateMeetingRecordStatus(persistedMeeting.id, {
      status: 'transcript_ready',
      transcriptStoredAt: new Date(),
      errorType: null,
      errorMessage: null,
    });

    logFeishuMonitor('info', 'transcript_export_finished', {
      meetingId: context.meetingId,
      minuteToken: context.minuteToken,
      recordId: record.recordId,
      transcriptLength: transcript.length,
      durationMs: Date.now() - transcriptStartedAt,
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
    // 先查 Supabase：如果 analysis_result 已存在，说明 LLM 分析成功但 Base 同步失败
    // 否则属于 LLM 分析失败（或更早阶段失败）
    const reportState = await getMeetingRecordByIntegrationAndMeeting(
      context.integration.id,
      context.meetingId
    );
    const hasAnalysisResult = Boolean(reportState?.analysisResult);
    const baseStatus = hasAnalysisResult
      ? FEISHU_PROCESS_STATUS.baseSyncFailed  // 写入失败：LLM 成功但 Base 同步失败
      : FEISHU_PROCESS_STATUS.failed;        // 分析失败：LLM 分析未成功
    try {
      await setMeetingProcessStatus(config, record.recordId, baseStatus);
    } catch (baseStatusError) {
      logFeishuMonitor('warn', 'meeting_report_base_failure_status_write_failed', {
        userId: context.integration.userId,
        integrationId: context.integration.id,
        taskId: context.taskId,
        meetingId: context.meetingId,
        recordId: record.recordId,
        ...toErrorContext(baseStatusError),
      });
    }
    await updateMeetingRecordStatus(persistedMeeting.id, {
      status: hasAnalysisResult ? 'base_sync_failed' : 'failed',
      errorType: error instanceof Error ? error.name : 'MeetingPipelineFailed',
      errorMessage: toBusinessErrorMessage(error),
    });
    logFeishuMonitor('error', 'meeting_pipeline_failed', {
      meetingId: context.meetingId,
      minuteToken: context.minuteToken,
      recordId: record.recordId,
      attempt: context.attempt,
      ...buildPipelineDurationContext(context, Date.now()),
      ...toErrorContext(error),
    });
    if (context.taskId) {
      await scheduleOrFailMeetingPipelineTask(context, error);
      return;
    }
    throw error;
  } finally {
    processingMeetingIds.delete(pipelineKey);
  }
}

async function scheduleOrFailMeetingPipelineTask(
  context: MinuteGeneratedSource,
  error: unknown
): Promise<void> {
  if (!context.taskId) {
    throw error;
  }

  const nextAttempt = context.attempt + 1;
  const errorType = error instanceof Error ? error.name : 'MeetingPipelineFailed';
  const errorMessage = toBusinessErrorMessage(error);

  if (nextAttempt < PIPELINE_MAX_ATTEMPTS) {
    const nextRunDelayMs = PIPELINE_RETRY_DELAY_MS * nextAttempt;
    await scheduleMeetingPipelineTask(context.taskId, {
      currentStage: FEISHU_PROCESS_STATUS.fetchingTranscript,
      attemptCount: nextAttempt,
      nextRunAt: new Date(Date.now() + nextRunDelayMs),
      errorType,
      errorMessage,
    });
    logFeishuMonitor('warn', 'meeting_pipeline_retry_scheduled', {
      userId: context.integration.userId,
      integrationId: context.integration.id,
      taskId: context.taskId,
      meetingId: context.meetingId,
      attempt: nextAttempt,
      maxAttempts: PIPELINE_MAX_ATTEMPTS,
      nextRunDelayMs,
    });
    return;
  }

  await failMeetingPipelineTask(context.taskId, {
    currentStage: FEISHU_PROCESS_STATUS.fetchingTranscript,
    attemptCount: nextAttempt,
    errorType,
    errorMessage,
  });
  logFeishuMonitor('error', 'meeting_pipeline_retry_exhausted', {
    userId: context.integration.userId,
    integrationId: context.integration.id,
    taskId: context.taskId,
    meetingId: context.meetingId,
    attempt: nextAttempt,
    maxAttempts: PIPELINE_MAX_ATTEMPTS,
    errorType,
  });
}

async function fetchTranscriptWithRetries(context: MinuteGeneratedSource): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= TRANSCRIPT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchTranscriptByMinuteToken(context.minuteToken, context.integration);
    } catch (error) {
      lastError = error;
      const retryable = isRetryableMinuteError(error);
      logFeishuMonitor(retryable ? 'warn' : 'error', 'transcript_export_failed', {
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
  const completionStartedAt = Date.now();
  const targetContext = {
    projectId: config.orgTarget?.projectId || null,
    orgTargetId: config.orgTarget?.id || null,
    orgKey: config.orgTarget?.orgKey || null,
    orgName: config.orgTarget?.orgName || null,
    tableId: config.tableId,
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

  const transcriptWriteStartedAt = Date.now();

  // 1. 先写 Supabase（真相源）：upsert 会议记录 + 写 transcript
  if (!context.meetingRecordId) {
    const persisted = await upsertMeetingRecord({
      integration: context.integration,
      meetingId: context.meetingId,
      minuteToken,
      projectId: config.orgTarget?.projectId || null,
      orgTargetId: config.orgTarget?.id || null,
      baseRecordId: record.recordId,
      details: context.meetingDetails,
    });
    context.meetingRecordId = persisted.id;
    context.reportPublicId = persisted.reportPublicId;
  }
  const supabaseRow = await updateMeetingRecordTranscript(context.meetingRecordId, transcript);
  await updateMeetingRecordStatus(context.meetingRecordId, {
    status: 'analyzing',
    transcriptStoredAt: new Date(),
    errorType: null,
    errorMessage: null,
  });

  // 2. 从 Supabase 同步到 Base（展示镜像）
  // 「创建人」字段写入 authorized_user_name（飞书授权用户姓名），由 feishu_authorizations 表提供
  // 「处理状态」不再在中间态写入 Base，Base 只展示终态（已完成/失败），中间态只保留在 Supabase
  const authorizationContext = await getLatestFeishuAuthorizationContext(context.integration.id);
  await syncPartialFieldsToBase(config, record.recordId, {
    '会议文字稿': transcript,
    '创建人': authorizationContext?.authorizedUserName ?? supabaseRow.organizerOpenId ?? undefined,
  });

  logFeishuMonitor('info', 'base_record_transcript_write_succeeded', {
    meetingId: context.meetingId,
    minuteToken,
    recordId: record.recordId,
    meetingRecordId: context.meetingRecordId,
    transcriptLength: transcript.length,
    durationMs: Date.now() - transcriptWriteStartedAt,
    ...targetContext,
  });

  const existingPersistedReport = await getMeetingRecordByIntegrationAndMeeting(
    context.integration.id,
    context.meetingId
  );
  const analysis =
    existingPersistedReport?.analysisResult ||
    await analyzeMeetingTranscriptWithRetries(transcript, {
      meetingId: context.meetingId,
      recordId: record.recordId,
      minuteToken,
    });
  if (existingPersistedReport?.analysisResult) {
    logFeishuMonitor('info', 'meeting_report_reused', {
      userId: context.integration.userId,
      integrationId: context.integration.id,
      taskId: context.taskId,
      meetingId: context.meetingId,
      meetingRecordId: existingPersistedReport.id,
      reportPublicId: existingPersistedReport.reportPublicId,
    });
    context.meetingRecordId = existingPersistedReport.id;
    context.reportPublicId = existingPersistedReport.reportPublicId;
  }

  if (!context.reportPublicId) {
    throw new Error('会议记录缺少 report_public_id，无法生成永久报告链接。');
  }
  const reportUrl = buildPersistentReportUrl(context.reportPublicId);

  logFeishuMonitor('info', 'meeting_report_persist_started', {
    userId: context.integration.userId,
    integrationId: context.integration.id,
    taskId: context.taskId,
    meetingId: context.meetingId,
    meetingRecordId: context.meetingRecordId,
    reportPublicId: context.reportPublicId,
    reusedAnalysis: Boolean(existingPersistedReport?.analysisResult),
  });

  let persistedReport;
  const reportPersistStartedAt = Date.now();
  try {
    persistedReport = await persistMeetingReport({
      meetingRecordId: context.meetingRecordId,
      analysis,
      reportUrl,
    });
  } catch (error) {
    await writeAuditLog({
      userId: context.integration.userId,
      integrationId: context.integration.id,
      action: 'meeting.report.persist',
      result: 'failed',
      summary: '持久化会议分析报告失败',
      metadata: {
        meetingId: context.meetingId,
        meetingRecordId: context.meetingRecordId,
        reportPublicId: context.reportPublicId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
    });
    logFeishuMonitor('error', 'meeting_report_persist_failed', {
      userId: context.integration.userId,
      integrationId: context.integration.id,
      taskId: context.taskId,
      meetingId: context.meetingId,
      meetingRecordId: context.meetingRecordId,
      reportPublicId: context.reportPublicId,
      ...toErrorContext(error),
    });
    throw error;
  }

  logFeishuMonitor('info', 'meeting_report_persist_succeeded', {
    userId: context.integration.userId,
    integrationId: context.integration.id,
    taskId: context.taskId,
    meetingId: context.meetingId,
    meetingRecordId: persistedReport.id,
    reportPublicId: persistedReport.reportPublicId,
    durationMs: Date.now() - reportPersistStartedAt,
  });
  await writeAuditLog({
    userId: context.integration.userId,
    integrationId: context.integration.id,
    action: 'meeting.report.persist',
    result: 'success',
    summary: '持久化会议分析报告',
    metadata: {
      meetingId: context.meetingId,
      meetingRecordId: persistedReport.id,
      reportPublicId: persistedReport.reportPublicId,
      projectId: config.orgTarget?.projectId || null,
      orgTargetId: config.orgTarget?.id || null,
      reusedAnalysis: Boolean(existingPersistedReport?.analysisResult),
    },
  });

  logFeishuMonitor('info', 'base_record_analysis_write_started', {
    meetingId: context.meetingId,
    minuteToken,
    recordId: record.recordId,
    reportUrl,
    ...targetContext,
  });

  logFeishuMonitor('info', 'meeting_report_base_sync_started', {
    userId: context.integration.userId,
    integrationId: context.integration.id,
    taskId: context.taskId,
    meetingId: context.meetingId,
    meetingRecordId: persistedReport.id,
    reportPublicId: persistedReport.reportPublicId,
    recordId: record.recordId,
    ...targetContext,
  });
  const baseSyncStartedAt = Date.now();
  try {
    // 从 Supabase 同步到 Base（统一字段映射）
    // persistedReport 包含 transcript（前面已写入）、analysisSummary、reportUrl、organizerOpenId 等
    // 「创建人」字段写入 authorized_user_name（飞书授权用户姓名），由 feishu_authorizations 表提供
    const authorizationContext = await getLatestFeishuAuthorizationContext(context.integration.id);
    await syncMeetingRecordToBase(config, persistedReport, {
      baseRecordId: record.recordId,
      orgName: config.orgTarget?.orgName,
      organizerName: authorizationContext?.authorizedUserName ?? null,
    });
  } catch (error) {
    await writeAuditLog({
      userId: context.integration.userId,
      integrationId: context.integration.id,
      action: 'meeting.report.base.sync',
      result: 'failed',
      summary: '同步会议报告用户字段到多维表格失败',
      metadata: {
        meetingId: context.meetingId,
        meetingRecordId: persistedReport.id,
        reportPublicId: persistedReport.reportPublicId,
        baseRecordId: record.recordId,
        projectId: config.orgTarget?.projectId || null,
        orgTargetId: config.orgTarget?.id || null,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
    });
    logFeishuMonitor('error', 'meeting_report_base_sync_failed', {
      userId: context.integration.userId,
      integrationId: context.integration.id,
      taskId: context.taskId,
      meetingId: context.meetingId,
      meetingRecordId: persistedReport.id,
      reportPublicId: persistedReport.reportPublicId,
      recordId: record.recordId,
      ...targetContext,
      ...toErrorContext(error),
    });
    throw error;
  }
  logFeishuMonitor('info', 'meeting_report_base_sync_succeeded', {
    userId: context.integration.userId,
    integrationId: context.integration.id,
    taskId: context.taskId,
    meetingId: context.meetingId,
    minuteToken,
    recordId: record.recordId,
    meetingRecordId: persistedReport.id,
    reportPublicId: persistedReport.reportPublicId,
    reportUrl,
    durationMs: Date.now() - baseSyncStartedAt,
    ...targetContext,
  });
  await writeAuditLog({
    userId: context.integration.userId,
    integrationId: context.integration.id,
    action: 'meeting.report.base.sync',
    result: 'success',
    summary: '同步会议报告用户字段到多维表格',
    metadata: {
      meetingId: context.meetingId,
      meetingRecordId: persistedReport.id,
      reportPublicId: persistedReport.reportPublicId,
      baseRecordId: record.recordId,
      projectId: config.orgTarget?.projectId || null,
      orgTargetId: config.orgTarget?.id || null,
    },
  });

  const pipelineCompletedAt = Date.now();
  logFeishuMonitor('info', 'meeting_pipeline_completed', {
    meetingId: context.meetingId,
    minuteToken,
    recordId: record.recordId,
    reportPublicId: persistedReport.reportPublicId,
    reportUrl,
    completionDurationMs: pipelineCompletedAt - completionStartedAt,
    ...buildPipelineDurationContext(context, pipelineCompletedAt),
    ...targetContext,
  });
  if (context.taskId) {
    await completeMeetingPipelineTask(context.taskId, {
      baseRecordId: record.recordId,
      minuteToken,
      payload: {
        reportUrl,
      },
    });
  }

  try {
    const notificationResult = await sendMeetingReportNotification({
      integration: context.integration,
      meetingId: context.meetingId,
      meetingName: context.meetingDetails?.topic ?? null,
      recordId: record.recordId,
      reportUrl,
      organizerOpenId: context.meetingDetails?.organizerOpenId ?? null,
    });
    logFeishuMonitor('info', 'meeting_pipeline_notification_completed', {
      integrationId: context.integration.id,
      meetingId: context.meetingId,
      minuteToken,
      recordId: record.recordId,
      reportPublicId: persistedReport.reportPublicId,
      reportUrl,
      messageId: notificationResult.messageId,
      notificationDurationMs: notificationResult.durationMs,
      ...buildPipelineDurationContext(context, Date.now()),
      ...targetContext,
    });
  } catch (error) {
    logFeishuMonitor('warn', 'meeting_pipeline_notification_skipped', {
      integrationId: context.integration.id,
      meetingId: context.meetingId,
      recordId: record.recordId,
      reportUrl,
      ...targetContext,
      ...toErrorContext(error),
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
    'integration' | 'meetingId' | 'minuteToken' | 'recordId' | 'meetingDetails'
  >,
  existing: FeishuMeetingRecord | null
): Promise<FeishuMeetingRecord> {
  // 1. 先写 Supabase（真相源）：upsert 会议记录，含 organizerOpenId
  const supabaseRow = await upsertMeetingRecord({
    integration: context.integration,
    meetingId: context.meetingId,
    minuteToken: context.minuteToken,
    projectId: config.orgTarget?.projectId || null,
    orgTargetId: config.orgTarget?.id || null,
    baseRecordId: context.recordId || existing?.recordId || null,
    details: context.meetingDetails,
  });

  // 2. 从 Supabase 同步到 Base
  // 「创建人」字段写入 authorized_user_name（飞书授权用户姓名），由 feishu_authorizations 表提供
  const authorizationContext = await getLatestFeishuAuthorizationContext(context.integration.id);
  const baseRecordId = await syncMeetingRecordToBase(config, supabaseRow, {
    baseRecordId: existing?.recordId || context.recordId || supabaseRow.baseRecordId || null,
    orgName: config.orgTarget?.orgName,
    organizerName: authorizationContext?.authorizedUserName ?? null,
  });

  // 3. 回写 baseRecordId 到 Supabase（如果新创建的）
  if (baseRecordId && baseRecordId !== supabaseRow.baseRecordId) {
    await updateMeetingRecordBaseReference(supabaseRow.id, baseRecordId);
  }

  if (existing) {
    return {
      ...existing,
      recordId: baseRecordId || existing.recordId,
      meetingId: context.meetingId,
      processStatus: FEISHU_PROCESS_STATUS.minuteGenerated,
    };
  }

  // 返回一个符合 FeishuMeetingRecord 结构的对象
  return {
    recordId: baseRecordId || '',
    meetingId: context.meetingId,
    processStatus: FEISHU_PROCESS_STATUS.minuteGenerated,
    analysisData: null,
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
    eventReceivedAt: getEventReceivedAtFromPayload(task.payload),
    taskStartedAt: task.startedAt?.toISOString(),
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

  const integration = await getFeishuIntegrationContextById(task.integrationId, {
    includeDeleted: true,
  });
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

  if (!(await isFeishuIntegrationActive(integration.id))) {
    await completeMeetingPipelineTask(task.id, {
      payload: {
        skippedReason: 'integration_inactive',
        skippedAt: new Date().toISOString(),
      },
    });
    logFeishuMonitor('info', 'inactive_integration_task_skipped', {
      taskId: task.id,
      integrationId: integration.id,
      meetingId: task.feishuMeetingId,
      eventId: task.eventId,
      message: '任务所属集成已被同一 Union ID 和组织下的更新集成取代。',
    });
    return;
  }

  // === Supabase-first 恢复路径 ===
  // 设计原则：Supabase 是唯一真相源，Base 只是展示镜像。pipeline 恢复时先查 Supabase，
  // 如果 status='analyzing' 且 transcript 已存在，直接走分析，跳过 Base 查询。
  // 这避免了 Base 镜像缺失导致恢复失败的问题（如手动测试场景或 Base 同步延迟）。
  try {
    const supabaseRecord = await getMeetingRecordByIntegrationAndMeeting(
      integration.id,
      task.feishuMeetingId
    );

    if (supabaseRecord?.status === 'analyzing' && supabaseRecord.transcript?.trim()) {
      // Supabase 已有 transcript 且 status='analyzing' → 直接走分析
      const config = await getMeetingBitableAccess({
        integration,
        targetOrgTargetId: getTargetFromPayload(task.payload),
      });

      const record: FeishuMeetingRecord = {
        recordId: supabaseRecord.baseRecordId || task.baseRecordId || '',
        meetingId: task.feishuMeetingId,
        processStatus: FEISHU_PROCESS_STATUS.analyzing,
        analysisData: supabaseRecord.analysisResult,
        transcript: supabaseRecord.transcript,
      };

      const context = buildRecoveryContextFromTask(task, integration);
      if (!context) {
        await failMeetingPipelineTask(task.id, {
          currentStage: task.currentStage as typeof FEISHU_PROCESS_STATUS[keyof typeof FEISHU_PROCESS_STATUS],
          attemptCount: task.attemptCount,
          errorType: 'TaskPayloadIncomplete',
          errorMessage: '会议任务缺少恢复所需的 payload 信息。',
        });
        return;
      }

      logFeishuMonitor('info', 'supabase_first_recovery_invoked', {
        taskId: task.id,
        integrationId: integration.id,
        meetingId: task.feishuMeetingId,
        transcriptSource: 'recovered-from-supabase',
        transcriptLength: supabaseRecord.transcript.length,
      });

      await completeMeetingAnalysis(
        config,
        record,
        supabaseRecord.transcript,
        'recovered-from-supabase',
        context
      );
      return;
    }
  } catch (error) {
    logFeishuMonitor('warn', 'supabase_first_recovery_failed', {
      taskId: task.id,
      integrationId: integration.id,
      meetingId: task.feishuMeetingId,
      ...toErrorContext(error),
    });
    // 失败时继续走原逻辑
  }
  // === Supabase-first 恢复路径结束 ===

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

  try {
    await processMinuteGeneratedAttempt(context);
  } catch (error) {
    logFeishuMonitor('error', 'meeting_pipeline_preparation_failed', {
      userId: context.integration.userId,
      integrationId: context.integration.id,
      taskId: context.taskId,
      meetingId: context.meetingId,
      attempt: context.attempt,
      ...toErrorContext(error),
    });
    await scheduleOrFailMeetingPipelineTask(context, error);
  }
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
