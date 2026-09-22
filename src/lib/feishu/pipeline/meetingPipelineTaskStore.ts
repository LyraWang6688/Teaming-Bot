import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type DbExecutor } from '@/lib/db/client';
import { meetingPipelineTasks, type MeetingPipelineTaskRow } from '@/lib/db/schema';
import type { FeishuIntegrationContext } from '../integration/integrationStore';
import { FEISHU_PROCESS_STATUS, type FeishuProcessStatus } from './status';

export const MEETING_PIPELINE_TASK_STATUS = {
  pending: 'pending',
  scheduled: 'scheduled',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
  blocked: 'blocked',
} as const;

export type MeetingPipelineTaskStatus =
  (typeof MEETING_PIPELINE_TASK_STATUS)[keyof typeof MEETING_PIPELINE_TASK_STATUS];

export type MeetingPipelineTaskPayload = {
  reportUrl?: string;
  /** Base 交付目标版本（meeting_records.data_version） */
  dataVersion?: number;
  /** 通知版本（meeting_records.report_revision） */
  reportRevision?: number;
  skippedReason?:
    | 'integration_inactive'
    | 'already_completed'
    | 'meeting_organizer_unresolved'
    | 'meeting_organizer_not_initialized'
    | 'meeting_organizer_owned_by_other_integration'
    | 'meeting_topic_keyword_mismatch'
    | 'minute_not_owner'
    | 'minute_read_forbidden'
    | 'minute_owner_missing'
    | 'minute_owner_not_initialized';
  gate?: { reasonCode: string; message: string; ownerOpenId?: string | null; checkedAt: string };
  skippedAt?: string;
  telemetry?: {
    eventReceivedAt?: string;
  };
  target?: {
    projectId: string;
    orgTargetId: string;
    orgKey: string;
    orgName: string;
  };
};

export type MeetingPipelineTargetSnapshot = NonNullable<MeetingPipelineTaskPayload['target']>;

type UpsertMeetingPipelineTaskInput = {
  integration: FeishuIntegrationContext | null;
  eventId?: string;
  eventType?: string;
  meetingId: string;
  minuteToken?: string;
  eventReceivedAt?: string;
  target?: MeetingPipelineTargetSnapshot;
};

type UpdateTaskFields = {
  currentStage?: FeishuProcessStatus;
  status?: MeetingPipelineTaskStatus;
  attemptCount?: number;
  baseRecordId?: string | null;
  minuteToken?: string | null;
  nextRunAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  lockedAt?: Date | null;
  lastErrorType?: string | null;
  lastErrorMessage?: string | null;
  payload?: MeetingPipelineTaskPayload;
};

function mergePayload(
  current: Record<string, unknown>,
  next?: MeetingPipelineTaskPayload
): Record<string, unknown> {
  if (!next) {
    return current;
  }

  return {
    ...current,
    ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
  };
}

export async function getMeetingPipelineTaskById(
  taskId: string,
  db: DbExecutor = getDb()
): Promise<MeetingPipelineTaskRow | null> {
  const [row] = await db
    .select()
    .from(meetingPipelineTasks)
    .where(eq(meetingPipelineTasks.id, taskId))
    .limit(1);

  return row || null;
}

async function getMeetingPipelineTaskByMeetingInternal(
  integrationId: string,
  meetingId: string
): Promise<MeetingPipelineTaskRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(meetingPipelineTasks)
    .where(
      and(
        eq(meetingPipelineTasks.integrationId, integrationId),
        eq(meetingPipelineTasks.feishuMeetingId, meetingId)
      )
    )
    .limit(1);

  return row || null;
}

export async function getMeetingPipelineTaskByEventId(
  integrationId: string,
  eventId: string
): Promise<MeetingPipelineTaskRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(meetingPipelineTasks)
    .where(
      and(
        eq(meetingPipelineTasks.integrationId, integrationId),
        eq(meetingPipelineTasks.eventId, eventId)
      )
    )
    .limit(1);

  return row || null;
}

export async function upsertMeetingPipelineTaskForMinuteGenerated(
  input: UpsertMeetingPipelineTaskInput
): Promise<{ task: MeetingPipelineTaskRow; duplicate: boolean; created: boolean }> {
  if (!input.integration) {
    throw new Error('数据库任务模式要求会议事件命中具体集成。');
  }

  const db = getDb();
  // Unique constraints are the authority. Duplicate delivery must never clear a
  // running lease or reset a completed/skipped/blocked task.
  const [inserted] = await db.insert(meetingPipelineTasks).values({
    userId: input.integration.userId,
    integrationId: input.integration.id,
    feishuMeetingId: input.meetingId,
    eventId: input.eventId || null,
    eventType: input.eventType || null,
    minuteToken: input.minuteToken || null,
    currentStage: FEISHU_PROCESS_STATUS.minuteGenerated,
    status: MEETING_PIPELINE_TASK_STATUS.pending,
    attemptCount: 0,
    payload: {
      telemetry: { eventReceivedAt: input.eventReceivedAt },
      ...(input.target ? { target: input.target } : {}),
    },
    nextRunAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing().returning();
  if (inserted) return { task: inserted, duplicate: false, created: true };

  const existing = (input.eventId
    ? await getMeetingPipelineTaskByEventId(input.integration.id, input.eventId)
    : null) || await getMeetingPipelineTaskByMeetingInternal(input.integration.id, input.meetingId);
  if (!existing) throw new Error('TaskConflictUnresolved');
  if (existing.feishuMeetingId !== input.meetingId ||
      (existing.minuteToken && input.minuteToken && existing.minuteToken !== input.minuteToken)) {
    // Do not silently replace a different recording in the one-task-per-meeting model.
    throw new Error('MeetingEventIdentityConflict');
  }
  return { task: existing, duplicate: true, created: false };
}

export async function updateMeetingPipelineTask(
  taskId: string,
  input: UpdateTaskFields,
  db: DbExecutor = getDb()
): Promise<MeetingPipelineTaskRow | null> {
  const existing = await getMeetingPipelineTaskById(taskId, db);
  if (!existing) {
    return null;
  }

  const [row] = await db
    .update(meetingPipelineTasks)
    .set({
      currentStage: input.currentStage ?? existing.currentStage,
      status: input.status ?? existing.status,
      attemptCount: input.attemptCount ?? existing.attemptCount,
      baseRecordId:
        input.baseRecordId === undefined ? existing.baseRecordId : input.baseRecordId,
      minuteToken: input.minuteToken === undefined ? existing.minuteToken : input.minuteToken,
      nextRunAt: input.nextRunAt === undefined ? existing.nextRunAt : input.nextRunAt,
      startedAt: input.startedAt === undefined ? existing.startedAt : input.startedAt,
      completedAt: input.completedAt === undefined ? existing.completedAt : input.completedAt,
      lockedAt: input.lockedAt === undefined ? existing.lockedAt : input.lockedAt,
      lastErrorType:
        input.lastErrorType === undefined ? existing.lastErrorType : input.lastErrorType,
      lastErrorMessage:
        input.lastErrorMessage === undefined
          ? existing.lastErrorMessage
          : input.lastErrorMessage,
      payload: mergePayload(existing.payload, input.payload),
      updatedAt: new Date(),
    })
    .where(eq(meetingPipelineTasks.id, taskId))
    .returning();

  return row || null;
}

export async function markMeetingPipelineTaskRunning(
  taskId: string,
  input: {
    currentStage: FeishuProcessStatus;
      attemptCount: number;
      minuteToken?: string | null;
    }
): Promise<MeetingPipelineTaskRow | null> {
  return updateMeetingPipelineTask(taskId, {
    currentStage: input.currentStage,
    status: MEETING_PIPELINE_TASK_STATUS.running,
    attemptCount: input.attemptCount,
    startedAt: new Date(),
    lockedAt: new Date(),
    nextRunAt: null,
    lastErrorType: null,
    lastErrorMessage: null,
  });
}

export async function scheduleMeetingPipelineTask(
  taskId: string,
  input: {
    currentStage: FeishuProcessStatus;
    attemptCount: number;
    nextRunAt: Date;
    errorType?: string | null;
    errorMessage?: string | null;
  }
): Promise<MeetingPipelineTaskRow | null> {
  return updateMeetingPipelineTask(taskId, {
    currentStage: input.currentStage,
    status: MEETING_PIPELINE_TASK_STATUS.scheduled,
    attemptCount: input.attemptCount,
    nextRunAt: input.nextRunAt,
    lockedAt: null,
    lastErrorType: input.errorType ?? null,
    lastErrorMessage: input.errorMessage ?? null,
  });
}

export async function completeMeetingPipelineTask(
  taskId: string,
  input?: {
    baseRecordId?: string | null;
    minuteToken?: string | null;
    payload?: MeetingPipelineTaskPayload;
  },
  db: DbExecutor = getDb()
): Promise<MeetingPipelineTaskRow | null> {
  return updateMeetingPipelineTask(taskId, {
    currentStage: FEISHU_PROCESS_STATUS.completed,
    status: MEETING_PIPELINE_TASK_STATUS.completed,
    baseRecordId: input?.baseRecordId,
    minuteToken: input?.minuteToken,
    completedAt: new Date(),
    nextRunAt: null,
    lockedAt: null,
    lastErrorType: null,
    lastErrorMessage: null,
    payload: input?.payload,
  }, db);
}

export async function failMeetingPipelineTask(
  taskId: string,
  input: {
    currentStage: FeishuProcessStatus;
    attemptCount: number;
    errorType?: string | null;
    errorMessage?: string | null;
  },
  db: DbExecutor = getDb()
): Promise<MeetingPipelineTaskRow | null> {
  return updateMeetingPipelineTask(taskId, {
    currentStage: input.currentStage,
    status: MEETING_PIPELINE_TASK_STATUS.failed,
    attemptCount: input.attemptCount,
    completedAt: new Date(),
    nextRunAt: null,
    lockedAt: null,
    lastErrorType: input.errorType ?? null,
    lastErrorMessage: input.errorMessage ?? null,
  }, db);
}

export async function listRecoverableMeetingPipelineTasks(
  limit = 100
): Promise<MeetingPipelineTaskRow[]> {
  const db = getDb();
  return db
    .select()
    .from(meetingPipelineTasks)
    .where(
      inArray(meetingPipelineTasks.status, [
        MEETING_PIPELINE_TASK_STATUS.pending,
        MEETING_PIPELINE_TASK_STATUS.scheduled,
        MEETING_PIPELINE_TASK_STATUS.running,
      ])
    )
    .orderBy(asc(meetingPipelineTasks.nextRunAt), asc(meetingPipelineTasks.updatedAt))
    .limit(limit);
}

type ClaimMeetingPipelineTasksOptions = {
  limit?: number;
  staleLockBefore?: Date;
};

/**
 * 通过数据库直接领取到期任务，避免事件监听线程自己执行耗时链路。
 * 这里使用 SKIP LOCKED 让多个实例可以安全并发抢占不同任务。
 */
export async function claimDueMeetingPipelineTasks(
  options: ClaimMeetingPipelineTasksOptions = {}
): Promise<MeetingPipelineTaskRow[]> {
  const db = getDb();
  const limit = Math.max(options.limit ?? 5, 1);
  const staleLockBefore =
    options.staleLockBefore ?? new Date(Date.now() - 20 * 60_000);

  const result = await db.execute(sql`
    update "meeting_pipeline_tasks" as task
    set
      "status" = ${MEETING_PIPELINE_TASK_STATUS.running},
      "locked_at" = now(),
      "started_at" = now(),
      "updated_at" = now()
    where task."id" in (
      select candidate."id"
      from "meeting_pipeline_tasks" as candidate
      where candidate."status" in (
        ${MEETING_PIPELINE_TASK_STATUS.pending},
        ${MEETING_PIPELINE_TASK_STATUS.scheduled},
        ${MEETING_PIPELINE_TASK_STATUS.running}
      )
        and coalesce(candidate."next_run_at", now()) <= now()
        and (
          candidate."locked_at" is null
          or candidate."locked_at" <= ${staleLockBefore}
        )
      order by coalesce(candidate."next_run_at", now()) asc, candidate."updated_at" asc
      limit ${limit}
      for update skip locked
    )
    returning *
  `);

  const ids = (result.rows ?? []).map((row) => (row as { id: string }).id);
  if (!ids.length) return [];
  return db.select().from(meetingPipelineTasks).where(inArray(meetingPipelineTasks.id, ids));
}
