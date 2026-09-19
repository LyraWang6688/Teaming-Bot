/**
 * 报告通知交付任务仓储
 *
 * - 幂等键创建时固定（meeting_record_id + report_revision + recipient），
 *   所有重试/崩溃恢复都复用同一键，飞书侧按键去重
 * - 接收人（app_id + open_id）建任务时绑定快照；blocked 后不自动换人
 * - 唯一键冲突（同一会议同一版本同一接收人）→ do nothing，视为已登记
 */
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db/client';
import {
  meetingReportNotificationTasks,
  type MeetingReportNotificationTaskRow,
} from '@/lib/db/schema';
import type { DeliveryDbExecutor } from './deliveryTaskStore';

export const NOTIFICATION_ERROR_CODE = {
  recipientMissing: 'RECIPIENT_MISSING',
  recipientMismatch: 'RECIPIENT_MISMATCH',
  sendPermissionDenied: 'SEND_PERMISSION_DENIED',
  sendTimeout: 'SEND_TIMEOUT',
  sendResultUnknown: 'SEND_RESULT_UNKNOWN',
  sendFailed: 'SEND_FAILED',
} as const;

export type EnqueueNotificationTaskInput = {
  meetingRecordId: string;
  reportRevision: number;
  integrationId: string;
  userId: string;
  recipientAppId: string;
  recipientOpenId: string;
  blockedReason?: string | null;
  reportUrl: string;
  meetingTitle?: string | null;
  /** 不传则按规则生成确定性幂等键 */
  idempotencyKey?: string;
};

export function buildNotificationIdempotencyKey(
  meetingRecordId: string,
  reportRevision: number,
  recipientAppId: string,
  recipientOpenId: string
): string {
  // 确定性键：同一会议版本 × 同一接收人永远只产生一个键
  return `report:${meetingRecordId}:r${reportRevision}:${recipientAppId}:${recipientOpenId}`;
}

/**
 * 登记通知任务。已存在（同会议/版本/接收人）返回 null，表示无需重复登记。
 */
export async function enqueueNotificationTask(
  input: EnqueueNotificationTaskInput,
  executor: DeliveryDbExecutor = getDb()
): Promise<MeetingReportNotificationTaskRow | null> {
  const idempotencyKey =
    input.idempotencyKey ??
    buildNotificationIdempotencyKey(
      input.meetingRecordId,
      input.reportRevision,
      input.recipientAppId,
      input.recipientOpenId
    );

  const result = await executor.execute(sql`
    insert into meeting_report_notification_tasks (
      meeting_record_id, report_revision, integration_id, user_id,
      recipient_app_id, recipient_open_id, report_url,
      meeting_title_snapshot, idempotency_key,
      status, attempt_count, next_run_at, last_error_code, last_error_summary, created_at, updated_at
    ) values (
      ${input.meetingRecordId}, ${input.reportRevision},
      ${input.integrationId}, ${input.userId},
      ${input.recipientAppId}, ${input.recipientOpenId},
      ${input.reportUrl}, ${input.meetingTitle ?? null},
      ${idempotencyKey},
      ${input.blockedReason ? 'blocked' : 'pending'}, 0,
      ${input.blockedReason ? null : new Date()},
      ${input.blockedReason ?? null},
      ${input.blockedReason ? '通知接收人缺失或不匹配；报告已保存，请核对会议创建人绑定后恢复。' : null},
      now(), now()
    )
    on conflict do nothing
    returning *
  `);

  return (result.rows?.[0] ?? null) as MeetingReportNotificationTaskRow | null;
}

export async function getNotificationTaskById(
  taskId: string
): Promise<MeetingReportNotificationTaskRow | null> {
  const [row] = await getDb()
    .select()
    .from(meetingReportNotificationTasks)
    .where(eq(meetingReportNotificationTasks.id, taskId))
    .limit(1);
  return row || null;
}

/** 供需要随机 UUID 幂等键的特殊场景（当前预留，默认走确定性键） */
export function newRandomIdempotencyKey(): string {
  return randomUUID();
}
