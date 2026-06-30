import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { AnalysisResult } from '@/types';
import { getDb } from '@/lib/db/client';
import { webAnalysisTasks, type WebAnalysisTaskRow } from '@/lib/db/schema';

export type WebAnalysisTaskStatus = 'pending' | 'analyzing' | 'completed' | 'failed';

export type PublicWebAnalysisTask = {
  id: string;
  status: WebAnalysisTaskStatus;
  fileName: string;
  result?: AnalysisResult;
  error?: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_ANALYZING_MS = 10 * 60 * 1000;

function getTaskExpiry(): Date {
  return new Date(Date.now() + TASK_TTL_MS);
}

function getStaleAnalyzingCutoff(): Date {
  return new Date(Date.now() - STALE_ANALYZING_MS);
}

function asStatus(value: string): WebAnalysisTaskStatus {
  if (value === 'pending' || value === 'analyzing' || value === 'completed' || value === 'failed') {
    return value;
  }

  return 'failed';
}

function serializeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function serializeWebAnalysisTask(row: WebAnalysisTaskRow): PublicWebAnalysisTask {
  return {
    id: row.id,
    status: asStatus(row.status),
    fileName: row.fileName,
    result: row.result || undefined,
    error: row.lastErrorMessage || undefined,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: serializeDate(row.startedAt),
    completedAt: serializeDate(row.completedAt),
  };
}

export async function createWebAnalysisTask(input: {
  fileName: string;
  meetingText: string;
}): Promise<WebAnalysisTaskRow> {
  const db = getDb();
  const [task] = await db
    .insert(webAnalysisTasks)
    .values({
      fileName: input.fileName,
      meetingText: input.meetingText,
      expiresAt: getTaskExpiry(),
    })
    .returning();

  if (!task) {
    throw new Error('创建网页分析任务失败');
  }

  return task;
}

export async function getWebAnalysisTask(taskId: string): Promise<WebAnalysisTaskRow | null> {
  const db = getDb();
  const [task] = await db
    .select()
    .from(webAnalysisTasks)
    .where(eq(webAnalysisTasks.id, taskId))
    .limit(1);

  return task || null;
}

export async function claimWebAnalysisTask(taskId: string): Promise<WebAnalysisTaskRow | null> {
  const db = getDb();
  const now = new Date();
  const staleBefore = getStaleAnalyzingCutoff();

  const [task] = await db
    .update(webAnalysisTasks)
    .set({
      status: 'analyzing',
      attemptCount: sql`${webAnalysisTasks.attemptCount} + 1`,
      startedAt: now,
      updatedAt: now,
      lastErrorType: null,
      lastErrorMessage: null,
    })
    .where(
      and(
        eq(webAnalysisTasks.id, taskId),
        or(
          eq(webAnalysisTasks.status, 'pending'),
          and(
            eq(webAnalysisTasks.status, 'analyzing'),
            or(isNull(webAnalysisTasks.startedAt), lt(webAnalysisTasks.startedAt, staleBefore))
          )
        )
      )
    )
    .returning();

  return task || null;
}

export async function completeWebAnalysisTask(
  taskId: string,
  result: AnalysisResult
): Promise<WebAnalysisTaskRow | null> {
  const db = getDb();
  const now = new Date();
  const [task] = await db
    .update(webAnalysisTasks)
    .set({
      status: 'completed',
      result,
      completedAt: now,
      updatedAt: now,
      lastErrorType: null,
      lastErrorMessage: null,
    })
    .where(eq(webAnalysisTasks.id, taskId))
    .returning();

  return task || null;
}

export async function failWebAnalysisTask(
  taskId: string,
  error: unknown
): Promise<WebAnalysisTaskRow | null> {
  const db = getDb();
  const now = new Date();
  const errorType = error instanceof Error ? error.name : 'Error';
  const errorMessage = error instanceof Error ? error.message : String(error);

  const [task] = await db
    .update(webAnalysisTasks)
    .set({
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      lastErrorType: errorType,
      lastErrorMessage: errorMessage || '分析失败',
    })
    .where(eq(webAnalysisTasks.id, taskId))
    .returning();

  return task || null;
}
