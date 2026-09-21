import { assertPublicReportUrl } from '@/lib/platform/serverRuntime';
/**
 * 报告通知交付任务执行器
 *
 * 规则：
 * - 接收人（recipient_app_id + recipient_open_id）与幂等键建任务时固定，
 *   执行时只认任务快照；会议记录上的接收人若已变成别人 → blocked，不自动换人
 * - 网络/超时等结果未知错误 → unknown，不盲目重发（消息可能已送达；
 *   飞书侧 uuid 幂等也会拦截同键重试，人工核对后可安全重放）
 * - 429/5xx → 退避重试；4xx / 业务拒收码 → blocked
 */
import { getDb } from '@/lib/db/client';
import { getMeetingRecordById } from '@/lib/reports/meetingReportStore';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import {
  getFeishuIntegrationContextById,
  writeAuditLog,
} from '../integration/integrationStore';
import { isFeishuIntegrationActive } from '../integration/integrationActivationService';
import { sendReportCardToRecipient } from '../im/reportNotificationService';
import { NOTIFICATION_ERROR_CODE } from './notificationTaskStore';
import {
  claimDueDeliveryTasks,
  completeDeliveryTask,
  DELIVERY_TABLE,
  failDeliveryAttempt,
  markDeliveryBlocked,
  markDeliveryUnknown,
  startLeaseHeartbeat,
  type DeliveryDbExecutor,
} from './deliveryTaskStore';

/** worker 领取返回的原生行（snake_case） */
export type ClaimedNotificationTask = {
  id: string;
  meeting_record_id: string;
  report_revision: number;
  integration_id: string;
  user_id: string;
  recipient_app_id: string;
  recipient_open_id: string;
  report_url: string;
  meeting_title_snapshot: string | null;
  idempotency_key: string;
  attempt_count: number;
  status: string;
  lease_token: string;
};

type Classification = {
  kind: 'retryable' | 'blocked' | 'unknown';
  code: string;
  summary: string;
};

function readErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as {
    statusCode?: number;
    status?: number;
    response?: { status?: number; statusCode?: number };
  };
  const value =
    candidate.statusCode ??
    candidate.status ??
    candidate.response?.status ??
    candidate.response?.statusCode;
  return typeof value === 'number' ? value : null;
}

function classifyNotificationError(error: unknown): Classification {
  const message = error instanceof Error ? error.message : String(error);
  const status = readErrorStatus(error);

  if (/timeout|aborted|network|fetch failed|socket|econnreset|etimedout/i.test(message)) {
    return {
      kind: 'unknown',
      code: NOTIFICATION_ERROR_CODE.sendResultUnknown,
      summary: `通知发送结果未知（网络/超时）：${message}`,
    };
  }

  if (status === 429 || (status !== null && status >= 500)) {
    return { kind: 'retryable', code: NOTIFICATION_ERROR_CODE.sendFailed, summary: message };
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'blocked',
      code: NOTIFICATION_ERROR_CODE.sendPermissionDenied,
      summary: `通知发送被拒绝（HTTP ${status}）：${message}`,
    };
  }
  if (status !== null && status >= 400) {
    return {
      kind: 'blocked',
      code: NOTIFICATION_ERROR_CODE.sendFailed,
      summary: `通知发送失败（HTTP ${status}）：${message}`,
    };
  }

  // 飞书业务码：接收人无效/不可达类，重试无意义
  const feishuCode =
    typeof error === 'object' && error !== null
      ? (error as { feishuCode?: number; code?: number }).feishuCode ??
        (error as { code?: number }).code
      : undefined;
  if (
    typeof feishuCode === 'number' &&
    [230001, 230002, 230020, 230006].includes(feishuCode)
  ) {
    return {
      kind: 'blocked',
      code: NOTIFICATION_ERROR_CODE.sendFailed,
      summary: `接收人不可达（飞书错误码 ${feishuCode}）：${message}`,
    };
  }

  // 其余错误默认可重试一次（交给退避上限兜底，超限 blocked）
  return { kind: 'retryable', code: NOTIFICATION_ERROR_CODE.sendFailed, summary: message };
}

export async function processNotificationTask(
  rawTask: ClaimedNotificationTask,
  db: DeliveryDbExecutor = getDb()
): Promise<void> {
  const lease = { id: rawTask.id, leaseToken: rawTask.lease_token };
  const stopHeartbeat = startLeaseHeartbeat({
    db,
    table: DELIVERY_TABLE.notification,
    task: lease,
  });

  try {
    const block = async (code: string, summary: string) => {
      await markDeliveryBlocked(db, DELIVERY_TABLE.notification, lease, code, summary);
      logFeishuMonitor('warn', 'delivery_notification_blocked', {
        taskId: rawTask.id,
        integrationId: rawTask.integration_id,
        meetingRecordId: rawTask.meeting_record_id,
        code,
        summary,
      });
    };

    const meeting = await getMeetingRecordById(rawTask.meeting_record_id);
    if (!meeting) {
      await block('MEETING_RECORD_NOT_FOUND', '关联的会议记录不存在，无法发送通知。');
      return;
    }

    const integration = await getFeishuIntegrationContextById(rawTask.integration_id, {
      includeDeleted: true,
    });
    if (!integration) {
      await block('INTEGRATION_MISSING', '任务关联的飞书集成不存在或已删除。');
      return;
    }
    if (!(await isFeishuIntegrationActive(integration.id))) {
      await block('INTEGRATION_INACTIVE', '任务所属集成已被新集成取代，停止发送通知。');
      return;
    }

    if (!rawTask.recipient_open_id || !rawTask.recipient_app_id) {
      await block(NOTIFICATION_ERROR_CODE.recipientMissing, '任务缺少已验证接收人，请核对后恢复。');
      return;
    }
    if (integration.appId !== rawTask.recipient_app_id) {
      await block(NOTIFICATION_ERROR_CODE.recipientMismatch, '集成应用与通知绑定的应用不一致。');
      return;
    }

    // 接收人已绑定成别人 → blocked，不自动换人换 app
    if (
      meeting.recipientAppId &&
      meeting.recipientOpenId &&
      (meeting.recipientAppId !== rawTask.recipient_app_id ||
        meeting.recipientOpenId !== rawTask.recipient_open_id)
    ) {
      await block(
        NOTIFICATION_ERROR_CODE.recipientMismatch,
        '会议记录当前接收人与任务快照不一致，按「blocked 不换人」原则停止发送。'
      );
      return;
    }

    try { assertPublicReportUrl(rawTask.report_url); } catch {
      await block('INVALID_REPORT_URL', '报告地址不是公网 HTTPS 地址，已阻止发送；请修正报告与任务地址后恢复。');
      return;
    }
    const startedAt = Date.now();
    try {
      const result = await sendReportCardToRecipient({
        integration,
        recipientOpenId: rawTask.recipient_open_id,
        meetingName: rawTask.meeting_title_snapshot ?? meeting.topic ?? null,
        reportUrl: rawTask.report_url,
        idempotencyKey: rawTask.idempotency_key,
      });

      const completed = await completeDeliveryTask(db, DELIVERY_TABLE.notification, lease, {
        messageId: result.messageId ?? undefined,
      });
      if (!completed) return;

      await writeAuditLog({
        userId: rawTask.user_id,
        integrationId: rawTask.integration_id,
        action: 'meeting.delivery.notification_send',
        result: 'success',
        summary: '会议报告通知发送成功',
        metadata: {
          taskId: rawTask.id,
          meetingRecordId: meeting.id,
          reportRevision: rawTask.report_revision,
          messageId: result.messageId,
          idempotencyKey: rawTask.idempotency_key,
        },
      });
      logFeishuMonitor('info', 'delivery_notification_succeeded', {
        taskId: rawTask.id,
        integrationId: rawTask.integration_id,
        meetingRecordId: meeting.id,
        messageId: result.messageId,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const classification = classifyNotificationError(error);
      if (classification.kind === 'blocked') {
        await block(classification.code, classification.summary);
        return;
      }
      if (classification.kind === 'unknown') {
        const ok = await markDeliveryUnknown(
          db,
          DELIVERY_TABLE.notification,
          lease,
          classification.code,
          classification.summary
        );
        logFeishuMonitor('error', 'delivery_notification_unknown', {
          taskId: rawTask.id,
          integrationId: rawTask.integration_id,
          meetingRecordId: meeting.id,
          ...toErrorContext(error),
          stateUpdated: ok,
        });
        return;
      }

      const finalState = await failDeliveryAttempt(
        db,
        DELIVERY_TABLE.notification,
        { ...lease, attemptCount: rawTask.attempt_count },
        {
          retryable: true,
          errorCode: classification.code,
          errorSummary: classification.summary,
        }
      );
      logFeishuMonitor('warn', 'delivery_notification_retry_or_blocked', {
        taskId: rawTask.id,
        integrationId: rawTask.integration_id,
        meetingRecordId: meeting.id,
        attemptCount: rawTask.attempt_count,
        finalState,
        ...toErrorContext(error),
      });
    }
  } finally {
    stopHeartbeat();
  }
}

/** worker 入口：领取到期通知任务并逐个执行 */
export async function claimAndProcessNotificationTasks(
  options: { limit?: number } = {}
): Promise<number> {
  const db = getDb();
  const tasks = await claimDueDeliveryTasks<ClaimedNotificationTask>(
    db,
    DELIVERY_TABLE.notification,
    { limit: options.limit ?? 3 }
  );

  for (const task of tasks) {
    try {
      await processNotificationTask(task, db);
    } catch (error) {
      logFeishuMonitor('error', 'delivery_notification_processor_crashed', {
        taskId: task.id,
        ...toErrorContext(error),
      });
      await failDeliveryAttempt(
        db,
        DELIVERY_TABLE.notification,
        { id: task.id, leaseToken: task.lease_token, attemptCount: task.attempt_count },
        {
          retryable: true,
          errorCode: 'PROCESSOR_CRASHED',
          errorSummary: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }

  return tasks.length;
}
