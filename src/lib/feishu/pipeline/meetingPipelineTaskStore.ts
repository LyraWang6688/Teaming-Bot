import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { meetingPipelineTasks, type MeetingPipelineTaskRow } from '@/lib/db/schema';
import type { FeishuIntegrationContext } from '../integration/integrationStore';
import { FEISHU_PROCESS_STATUS, type FeishuProcessStatus } from './status';

export const MEETING_PIPELINE_TASK_STATUS = {
  pending: 'pending',
  scheduled: 'scheduled',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
} as const;

export type MeetingPipelineTaskStatus =
  (typeof MEETING_PIPELINE_TASK_STATUS)[keyof typeof MEETING_PIPELINE_TASK_STATUS];

export type MeetingPipelineTaskPayload = {
  reportUrl?: string;
};

type UpsertMeetingPipelineTaskInput = {
  integration: FeishuIntegrationContext | null;
  eventId?: string;
  eventType?: string;
  meetingId: string;
  minuteToken?: string;
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
  taskId: string
): Promise<MeetingPipelineTaskRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(meetingPipelineTasks)
    .where(eq(meetingPipelineTasks.id, taskId))
    .limit(1);

  return row || null;
}

export async function getMeetingPipelineTaskByMeeting(
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

export async function upsertMeetingPipelineTaskForMeetingEnded(
  input: UpsertMeetingPipelineTaskInput
): Promise<{ task: MeetingPipelineTaskRow; duplicate: boolean; created: boolean }> {
  return upsertMeetingPipelineTaskForMinuteGenerated(input);
}

export async function upsertMeetingPipelineTaskForMinuteGenerated(
  input: UpsertMeetingPipelineTaskInput
): Promise<{ task: MeetingPipelineTaskRow; duplicate: boolean; created: boolean }> {
  if (!input.integration) {
    throw new Error('数据库任务模式要求会议事件命中具体集成。');
  }

  const db = getDb();
  const existing = await getMeetingPipelineTaskByMeeting(input.integration.id, input.meetingId);
  const payload: MeetingPipelineTaskPayload = {};

  if (!existing) {
    const [row] = await db
      .insert(meetingPipelineTasks)
      .values({
        userId: input.integration.userId,
        integrationId: input.integration.id,
        feishuMeetingId: input.meetingId,
        eventId: input.eventId || null,
        eventType: input.eventType || null,
        minuteToken: input.minuteToken || null,
        currentStage: FEISHU_PROCESS_STATUS.minuteGenerated,
        status: MEETING_PIPELINE_TASK_STATUS.pending,
        attemptCount: 0,
        payload,
        nextRunAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return {
      task: row,
      duplicate: false,
      created: true,
    };
  }

  const isDuplicateActive =
    existing.status === MEETING_PIPELINE_TASK_STATUS.pending ||
    existing.status === MEETING_PIPELINE_TASK_STATUS.scheduled ||
    existing.status === MEETING_PIPELINE_TASK_STATUS.running;

  const [row] = await db
    .update(meetingPipelineTasks)
    .set({
      eventId: input.eventId || existing.eventId,
      eventType: input.eventType || existing.eventType,
      minuteToken: input.minuteToken || existing.minuteToken,
      status:
        existing.status === MEETING_PIPELINE_TASK_STATUS.completed ||
        existing.status === MEETING_PIPELINE_TASK_STATUS.failed
          ? MEETING_PIPELINE_TASK_STATUS.pending
          : existing.status,
      currentStage:
        existing.status === MEETING_PIPELINE_TASK_STATUS.completed ||
        existing.status === MEETING_PIPELINE_TASK_STATUS.failed
          ? FEISHU_PROCESS_STATUS.minuteGenerated
          : existing.currentStage,
      attemptCount:
        existing.status === MEETING_PIPELINE_TASK_STATUS.completed ||
        existing.status === MEETING_PIPELINE_TASK_STATUS.failed
          ? 0
          : existing.attemptCount,
      nextRunAt:
        existing.status === MEETING_PIPELINE_TASK_STATUS.completed ||
        existing.status === MEETING_PIPELINE_TASK_STATUS.failed
          ? new Date()
          : existing.nextRunAt,
      startedAt:
        existing.status === MEETING_PIPELINE_TASK_STATUS.completed ||
        existing.status === MEETING_PIPELINE_TASK_STATUS.failed
          ? null
          : existing.startedAt,
      completedAt: null,
      lockedAt: null,
      lastErrorType: null,
      lastErrorMessage: null,
      payload: mergePayload(existing.payload, payload),
      updatedAt: new Date(),
    })
    .where(eq(meetingPipelineTasks.id, existing.id))
    .returning();

  return {
    task: row,
    duplicate: isDuplicateActive && existing.eventId === input.eventId,
    created: false,
  };
}

export async function updateMeetingPipelineTask(
  taskId: string,
  input: UpdateTaskFields
): Promise<MeetingPipelineTaskRow | null> {
  const db = getDb();
  const existing = await getMeetingPipelineTaskById(taskId);
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
  }
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
  });
}

export async function failMeetingPipelineTask(
  taskId: string,
  input: {
    currentStage: FeishuProcessStatus;
    attemptCount: number;
    errorType?: string | null;
    errorMessage?: string | null;
  }
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
  });
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

  return (result.rows ?? []) as MeetingPipelineTaskRow[];
}
