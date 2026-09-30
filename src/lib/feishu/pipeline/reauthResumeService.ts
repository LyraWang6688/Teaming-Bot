/**
 * 重新授权成功后的自动补发。
 *
 * 筛选该集成下因授权失效（oauth_* / integration_authorization_invalid）被 blocked 的任务：
 * - 事件时间在 85 天窗口内（飞书会议详情官方时效 90 天 - 5 天余量）→ 重新入队 pending
 * - 超出窗口 → 标记 skipped（expired_beyond_recovery_window），不再补发
 * 每个恢复的任务写 meeting.pipeline.auto_resume 审计。
 */
import { and, eq, or, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { meetingPipelineTasks } from '@/lib/db/schema';
import { writeAuditLog } from '../integration/integrationStore';
import { logFeishuMonitor } from '../common/monitor';
import { FEISHU_PROCESS_STATUS } from './status';
import { isWithinResumeWindow, REAUTH_GATE_REASON_LEGACY, REAUTH_GATE_REASON_PREFIX } from './reauthShared';

const EXPIRED_SKIP_REASON = 'expired_beyond_recovery_window';

type BlockedTaskRow = {
  id: string;
  feishuMeetingId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

function readEventReceivedAt(payload: Record<string, unknown>): string | null {
  const telemetry = payload?.telemetry as Record<string, unknown> | undefined;
  const value = telemetry?.eventReceivedAt;
  return typeof value === 'string' && value ? value : null;
}

export async function resumeOauthBlockedTasksForIntegration(options: {
  userId: string;
  integrationId: string;
}): Promise<{ requeued: number; expired: number }> {
  const { userId, integrationId } = options;
  const db = getDb();
  const rows = await db
    .select({
      id: meetingPipelineTasks.id,
      feishuMeetingId: meetingPipelineTasks.feishuMeetingId,
      payload: meetingPipelineTasks.payload,
      createdAt: meetingPipelineTasks.createdAt,
    })
    .from(meetingPipelineTasks)
    .where(
      and(
        eq(meetingPipelineTasks.integrationId, integrationId),
        eq(meetingPipelineTasks.status, 'blocked'),
        or(
          sql`${meetingPipelineTasks.payload} -> 'gate' ->> 'reasonCode' like ${REAUTH_GATE_REASON_PREFIX + '%'}`,
          sql`${meetingPipelineTasks.payload} -> 'gate' ->> 'reasonCode' = ${REAUTH_GATE_REASON_LEGACY}`
        )
      )
    );

  const now = new Date();
  let requeued = 0;
  let expired = 0;

  for (const row of rows as BlockedTaskRow[]) {
    const gate = (row.payload?.gate || {}) as Record<string, unknown>;
    if (isWithinResumeWindow(readEventReceivedAt(row.payload), row.createdAt, now.getTime())) {
      await db
        .update(meetingPipelineTasks)
        .set({
          status: 'pending',
          currentStage: FEISHU_PROCESS_STATUS.minuteGenerated,
          attemptCount: 0,
          nextRunAt: now,
          startedAt: null,
          completedAt: null,
          lockedAt: null,
          lastErrorType: null,
          lastErrorMessage: null,
          updatedAt: now,
        })
        .where(and(eq(meetingPipelineTasks.id, row.id), eq(meetingPipelineTasks.status, 'blocked')));
      requeued += 1;
      await writeAuditLog({
        userId,
        integrationId,
        action: 'meeting.pipeline.auto_resume',
        result: 'success',
        summary: '重新授权后自动恢复授权失效的会议任务',
        metadata: {
          taskId: row.id,
          meetingId: row.feishuMeetingId,
          originalReasonCode: typeof gate.reasonCode === 'string' ? gate.reasonCode : null,
          operator: 'system',
        },
      });
    } else {
      await db
        .update(meetingPipelineTasks)
        .set({
          status: 'skipped',
          lastErrorType: null,
          lastErrorMessage: null,
          payload: {
            ...row.payload,
            gate: { ...gate, reasonCode: EXPIRED_SKIP_REASON, message: '会议已超出 90 天可恢复窗口，不再补发。' },
          },
          updatedAt: now,
        })
        .where(and(eq(meetingPipelineTasks.id, row.id), eq(meetingPipelineTasks.status, 'blocked')));
      expired += 1;
    }
  }

  logFeishuMonitor('info', 'reauth_auto_resume_finished', { integrationId, requeued, expired });
  return { requeued, expired };
}
