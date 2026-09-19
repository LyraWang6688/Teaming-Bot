/**
 * Base 交付任务执行器
 *
 * 由 delivery worker 领取后调用 processBaseSyncTask。
 *
 * 关键规则：
 * - 目标只认任务行上的快照（projectId/orgTargetId），不再重新解析「当前选中项目」
 * - required 字段未绑定/类型不符 → blocked（不盲目重试）
 * - 非 required 缺失 → 其余字段照常单次合并写入，任务标 partial
 * - 写入遇 FieldNameNotFound → 强刷绑定后重试一次；仍失败 → blocked
 * - 401/403/404/400 等确定性失败 → blocked；429/5xx → 退避重试；
 *   网络/超时等结果未知 → unknown，不自动重发，避免重复建行
 * - 成功后若 requested_version 已被推进 → 立即重新排队
 * - 任何 Base 失败都不影响分析状态与报告通知
 */
import { getDb } from '@/lib/db/client';
import {
  getMeetingRecordById,
  updateMeetingRecordBaseReference,
} from '@/lib/reports/meetingReportStore';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { FeishuOpenApiError } from '../common/openapi';
import { createOrgTargetBitableAccess } from '../bitable/bitableOpenApi';
import {
  BASE_BUSINESS_FIELD_SPECS,
  forceRefreshFieldBindings,
  isFieldNameNotFoundError,
  resolveBusinessFieldsDetailed,
  type BusinessFieldKey,
  type ResolveBusinessFieldsResult,
} from '../bitable/fieldBinding';
import {
  mapSupabaseRowToBusinessFields,
  persistResolvedFieldsToBase,
} from '../bitable/bitableSync';
import { getOrgTargetContextById } from '../projects/projectConfigStore';
import {
  getFeishuIntegrationContextById,
  getLatestFeishuAuthorizationContext,
  writeAuditLog,
} from '../integration/integrationStore';
import { isFeishuIntegrationActive } from '../integration/integrationActivationService';
import {
  BASE_SYNC_ERROR_CODE,
  getBaseSyncTaskById,
} from './baseSyncTaskStore';
import {
  claimDueDeliveryTasks,
  completeDeliveryTask,
  DELIVERY_TABLE,
  failDeliveryAttempt,
  markDeliveryBlocked,
  markDeliveryUnknown,
  requeueDeliveryTask,
  startLeaseHeartbeat,
  type DeliveryDbExecutor,
} from './deliveryTaskStore';

/** worker 领取返回的原生行（snake_case） */
export type ClaimedBaseSyncTask = {
  id: string;
  meeting_record_id: string;
  integration_id: string;
  user_id: string;
  project_id: string | null;
  org_target_id: string | null;
  target_key: string;
  target_config_snapshot: Record<string, unknown> | null;
  mapping_version: number | null;
  requested_version: number;
  synced_version: number;
  attempt_count: number;
  base_record_id: string | null;
  partial: boolean;
  status: string;
  lease_token: string;
};

type TargetSnapshot = {
  projectId?: string | null;
  orgTargetId?: string | null;
  orgName?: string | null;
};

function parseSnapshot(raw: ClaimedBaseSyncTask['target_config_snapshot']): TargetSnapshot {
  if (!raw || typeof raw !== 'object') return {};
  const snap = raw as Record<string, unknown>;
  return {
    projectId: typeof snap.projectId === 'string' ? snap.projectId : null,
    orgTargetId: typeof snap.orgTargetId === 'string' ? snap.orgTargetId : null,
    orgName: typeof snap.orgName === 'string' ? snap.orgName : null,
  };
}

type ErrorClassification = {
  kind: 'retryable' | 'blocked' | 'unknown';
  code: string;
  summary: string;
};

function classifyWriteError(error: unknown): ErrorClassification {
  const message = error instanceof Error ? error.message : String(error);

  // 原生网络层错误（fetch failed / timeout / aborted）：请求结果未知
  if (
    !(error instanceof FeishuOpenApiError) &&
    /timeout|aborted|network|fetch failed|socket|econnreset|etimedout/i.test(message)
  ) {
    return {
      kind: 'unknown',
      code: BASE_SYNC_ERROR_CODE.writeFailed,
      summary: `Base 写入请求结果未知（网络/超时）：${message}`,
    };
  }

  if (error instanceof FeishuOpenApiError) {
    const status = error.statusCode ?? 0;
    if (status === 429 || status >= 500) {
      return { kind: 'retryable', code: BASE_SYNC_ERROR_CODE.writeFailed, summary: message };
    }
    if (status === 401 || status === 403) {
      return {
        kind: 'blocked',
        code: BASE_SYNC_ERROR_CODE.writePermissionDenied,
        summary: `Base 写入被拒绝（HTTP ${status}）：${message}`,
      };
    }
    if (status === 404) {
      return {
        kind: 'blocked',
        code: BASE_SYNC_ERROR_CODE.projectMissing,
        summary: `Base 应用或数据表不存在（HTTP 404）：${message}`,
      };
    }
    if (status === 400) {
      return {
        kind: 'blocked',
        code: BASE_SYNC_ERROR_CODE.fieldTypeMismatch,
        summary: `Base 拒绝写入内容（HTTP 400，常见于单选选项不存在/字段值类型不符）：${message}`,
      };
    }
    // FieldNameNotFound 在调用处已做过一次强刷重试，走到这里视为确定性失败
    if (isFieldNameNotFoundError(error)) {
      return {
        kind: 'blocked',
        code: BASE_SYNC_ERROR_CODE.fieldNameNotFound,
        summary: `刷新绑定后仍报字段名不存在：${message}`,
      };
    }
  }

  return {
    kind: 'blocked',
    code: BASE_SYNC_ERROR_CODE.writeFailed,
    summary: message,
  };
}

function requiredBlockedSummary(resolution: ResolveBusinessFieldsResult): string | null {
  const missingRequired = resolution.skipped
    .filter((item) => BASE_BUSINESS_FIELD_SPECS[item.key as BusinessFieldKey].required)
    .map((item) => `${item.canonicalName}(${item.reason})`);
  if (missingRequired.length === 0) return null;
  return `必填字段未就绪，已阻止写入：${missingRequired.join('、')}。请在 Base 中补建/修正字段后重试。`;
}

async function writeWithSelfHeal(
  access: Parameters<typeof persistResolvedFieldsToBase>[0],
  businessFields: ReturnType<typeof mapSupabaseRowToBusinessFields>,
  knownRecordId: string | null,
  meetingId: string
): Promise<{
  recordId: string;
  mode: 'updated' | 'updated_by_lookup' | 'created';
  resolution: ResolveBusinessFieldsResult;
}> {
  let resolution = await resolveBusinessFieldsDetailed(access, businessFields);
  let requiredSummary = requiredBlockedSummary(resolution);
  if (requiredSummary) {
    throw Object.assign(new Error(requiredSummary), { __requiredUnbound: true });
  }

  try {
    const result = await persistResolvedFieldsToBase(
      access,
      resolution.fields,
      knownRecordId,
      meetingId
    );
    return { ...result, resolution };
  } catch (error) {
    if (!isFieldNameNotFoundError(error)) throw error;

    logFeishuMonitor('warn', 'delivery_base_field_name_not_found_refresh', {
      integrationId: access.integrationId,
      userId: access.userId,
      meetingId,
      ...toErrorContext(error instanceof Error ? error : new Error(String(error))),
    });

    await forceRefreshFieldBindings(access);
    resolution = await resolveBusinessFieldsDetailed(access, businessFields);
    requiredSummary = requiredBlockedSummary(resolution);
    if (requiredSummary) {
      throw Object.assign(new Error(requiredSummary), { __requiredUnbound: true });
    }
    const result = await persistResolvedFieldsToBase(
      access,
      resolution.fields,
      knownRecordId,
      meetingId
    );
    return { ...result, resolution };
  }
}

/**
 * 执行一个已被领取（持有租约）的 Base 同步任务。
 * 状态流转全部通过 deliveryTaskStore 原语完成。
 */
export async function processBaseSyncTask(
  rawTask: ClaimedBaseSyncTask,
  db: DeliveryDbExecutor = getDb()
): Promise<void> {
  const lease = { id: rawTask.id, leaseToken: rawTask.lease_token };
  const stopHeartbeat = startLeaseHeartbeat({
    db,
    table: DELIVERY_TABLE.baseSync,
    task: lease,
  });

  try {
    const snapshot = parseSnapshot(rawTask.target_config_snapshot);
    const projectId = snapshot.projectId ?? rawTask.project_id;
    const orgTargetId = snapshot.orgTargetId ?? rawTask.org_target_id;

    const block = async (code: string, summary: string) => {
      await markDeliveryBlocked(db, DELIVERY_TABLE.baseSync, lease, code, summary);
      logFeishuMonitor('warn', 'delivery_base_blocked', {
        taskId: rawTask.id,
        integrationId: rawTask.integration_id,
        meetingRecordId: rawTask.meeting_record_id,
        code,
        summary,
      });
    };

    if (!projectId || !orgTargetId) {
      await block(
        BASE_SYNC_ERROR_CODE.targetNotConfigured,
        '任务快照缺少目标项目/组织方向，无法写入 Base。'
      );
      return;
    }

    const meeting = await getMeetingRecordById(rawTask.meeting_record_id);
    if (!meeting) {
      await block('MEETING_RECORD_NOT_FOUND', '关联的会议记录不存在，无法同步 Base。');
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
      await block('INTEGRATION_INACTIVE', '任务所属集成已被新集成取代，停止镜像写入。');
      return;
    }

    // 目标固定：只认快照里的 orgTargetId，不重新解析「当前选中项目」
    const orgTarget = await getOrgTargetContextById(orgTargetId);
    if (!orgTarget || orgTarget.projectId !== projectId) {
      await block(
        BASE_SYNC_ERROR_CODE.projectMissing,
        `快照对应的组织方向/项目已不存在或不匹配（orgTargetId=${orgTargetId}）。`
      );
      return;
    }

    const access = await createOrgTargetBitableAccess(integration, orgTarget);
    const authorization = await getLatestFeishuAuthorizationContext(integration.id);
    const businessFields = mapSupabaseRowToBusinessFields(meeting, {
      orgName: snapshot.orgName ?? orgTarget.orgName,
      organizerName: authorization?.authorizedUserName ?? null,
    });

    if (Object.keys(businessFields).length === 0) {
      await block('NO_BUSINESS_FIELDS', '没有可写入 Base 的业务字段。');
      return;
    }

    const knownRecordId = rawTask.base_record_id || meeting.baseRecordId || null;
    const startedAt = Date.now();

    try {
      const writeResult = await writeWithSelfHeal(
        access,
        businessFields,
        knownRecordId,
        meeting.feishuMeetingId
      );
      const partial = writeResult.resolution.skipped.length > 0;

      if (writeResult.recordId && writeResult.recordId !== meeting.baseRecordId) {
        await updateMeetingRecordBaseReference(meeting.id, writeResult.recordId);
      }

      await completeDeliveryTask(db, DELIVERY_TABLE.baseSync, lease, {
        baseRecordId: writeResult.recordId,
        syncedVersion: rawTask.requested_version,
        partial,
      });

      await writeAuditLog({
        userId: rawTask.user_id,
        integrationId: rawTask.integration_id,
        action: 'meeting.delivery.base_sync',
        result: partial ? 'partial' : 'success',
        summary: partial
          ? `Base 部分字段同步成功，跳过：${writeResult.resolution.skipped
              .map((item) => `${item.canonicalName}(${item.reason})`)
              .join('、')}`
          : 'Base 镜像同步成功',
        metadata: {
          taskId: rawTask.id,
          meetingRecordId: meeting.id,
          meetingId: meeting.feishuMeetingId,
          baseRecordId: writeResult.recordId,
          mode: writeResult.mode,
          requestedVersion: rawTask.requested_version,
          partial,
          skipped: writeResult.resolution.skipped,
        },
      });
      logFeishuMonitor('info', 'delivery_base_succeeded', {
        taskId: rawTask.id,
        integrationId: rawTask.integration_id,
        meetingRecordId: meeting.id,
        baseRecordId: writeResult.recordId,
        mode: writeResult.mode,
        partial,
        durationMs: Date.now() - startedAt,
      });

      // 执行期间可能已有新版本入队（status 当时为 running，冲突更新不会自动重排）
      const latest = await getBaseSyncTaskById(rawTask.id);
      if (latest && latest.requestedVersion > latest.syncedVersion) {
        await requeueDeliveryTask(db, DELIVERY_TABLE.baseSync, lease);
        logFeishuMonitor('info', 'delivery_base_requeued_new_version', {
          taskId: rawTask.id,
          requestedVersion: latest.requestedVersion,
          syncedVersion: latest.syncedVersion,
        });
      }
    } catch (error) {
      const requiredUnbound =
        typeof error === 'object' &&
        error !== null &&
        (error as { __requiredUnbound?: boolean }).__requiredUnbound === true;

      if (requiredUnbound) {
        await block(
          BASE_SYNC_ERROR_CODE.requiredFieldUnbound,
          error instanceof Error ? error.message : String(error)
        );
        return;
      }

      const classification = classifyWriteError(error);
      if (classification.kind === 'blocked') {
        await block(classification.code, classification.summary);
        return;
      }
      if (classification.kind === 'unknown') {
        const ok = await markDeliveryUnknown(
          db,
          DELIVERY_TABLE.baseSync,
          lease,
          classification.code,
          classification.summary
        );
        logFeishuMonitor('error', 'delivery_base_unknown', {
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
        DELIVERY_TABLE.baseSync,
        { ...lease, attemptCount: rawTask.attempt_count },
        {
          retryable: true,
          errorCode: classification.code,
          errorSummary: classification.summary,
        }
      );
      logFeishuMonitor('warn', 'delivery_base_retry_or_blocked', {
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

/** worker 入口：领取到期 Base 任务并逐个执行 */
export async function claimAndProcessBaseSyncTasks(
  options: { limit?: number } = {}
): Promise<number> {
  const db = getDb();
  const tasks = await claimDueDeliveryTasks<ClaimedBaseSyncTask>(
    db,
    DELIVERY_TABLE.baseSync,
    { limit: options.limit ?? 3 }
  );

  for (const task of tasks) {
    try {
      await processBaseSyncTask(task, db);
    } catch (error) {
      // 执行器自身的未兜底异常（不应发生）：按可重试处理，避免任务卡 running
      logFeishuMonitor('error', 'delivery_base_processor_crashed', {
        taskId: task.id,
        ...toErrorContext(error),
      });
      await failDeliveryAttempt(
        db,
        DELIVERY_TABLE.baseSync,
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
