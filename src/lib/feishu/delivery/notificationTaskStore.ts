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
  /**
   * 抑制推送：以 `cancelled` 入队。任务照常留痕（收件人、报告 URL、标题都在），
   * 但交付 worker 只领取 pending/retry_wait，所以不会被发送。
   * 需要补推时把 status 改回 pending 即可。
   *
   * 用于补历史积压：先写多维表格、不打扰用户。
   */
  suppressed?: boolean;
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
 * 决定通知任务的初始状态与错误摘要。
 *
 * 优先级：接收人问题（blocked）> 主动抑制（cancelled）> 正常待发（pending）。
 *
 * `cancelled` 必须落在数据库 CHECK 允许的取值内：
 * ('pending','running','retry_wait','succeeded','blocked','unknown','cancelled')。
 * 交付 worker 只领取 pending/retry_wait，所以 cancelled 不会被发送，
 * 但任务行保留了收件人、报告 URL、标题，事后可改回 pending 补推。
 */
export function resolveInitialNotificationState(input: {
  blockedReason?: string | null;
  suppressed?: boolean;
}): { status: 'blocked' | 'cancelled' | 'pending'; errorCode: string | null; errorSummary: string | null } {
  if (input.blockedReason) {
    return {
      status: 'blocked',
      errorCode: input.blockedReason,
      errorSummary: '通知接收人缺失或不匹配；报告已保存，请核对会议创建人绑定后恢复。',
    };
  }
  if (input.suppressed) {
    return {
      status: 'cancelled',
      errorCode: null,
      errorSummary: '按任务标记抑制推送；报告与多维表格已写入，需要时把 status 改回 pending 即可补推。',
    };
  }
  return { status: 'pending', errorCode: null, errorSummary: null };
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

  // 优先级：接收人问题（blocked）> 主动抑制（cancelled）> 正常待发（pending）
  const initialState = resolveInitialNotificationState({
    blockedReason: input.blockedReason,
    suppressed: input.suppressed,
  });
  const initialStatus = initialState.status;
  const initialErrorCode = initialState.errorCode;
  const initialErrorSummary = initialState.errorSummary;

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
      ${initialStatus}, 0,
      ${initialStatus === 'pending' ? new Date() : null},
      ${initialErrorCode},
      ${initialErrorSummary},
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
