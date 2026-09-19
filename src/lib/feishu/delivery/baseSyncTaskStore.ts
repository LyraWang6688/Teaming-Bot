/**
 * Base 交付任务仓储
 *
 * - 一个会议 × 一个稳定目标（target_key）只有一个任务
 * - 目标（projectId/orgTargetId）在任务创建时写入快照，之后执行只认该快照
 * - 未绑定项目时任务直接以 blocked + TARGET_NOT_CONFIGURED 创建
 * - blocked/unknown/cancelled 期间版本推进只更新 requested_version，不自动重新排队；
 *   succeeded 后出现新版本 → 重新置 pending
 */
import { eq, sql } from 'drizzle-orm';
import { encrypt } from '@/lib/security/crypto';
import { getDb } from '@/lib/db/client';
import {
  meetingBaseSyncTasks,
  type MeetingBaseSyncTaskRow,
} from '@/lib/db/schema';
import type { DeliveryDbExecutor } from './deliveryTaskStore';
import { DELIVERY_TABLE } from './deliveryTaskStore';

export const UNBOUND_TARGET_KEY = 'project:unbound';

export const BASE_SYNC_ERROR_CODE = {
  targetNotConfigured: 'TARGET_NOT_CONFIGURED',
  projectMissing: 'PROJECT_MISSING',
  requiredFieldUnbound: 'REQUIRED_FIELD_UNBOUND',
  fieldTypeMismatch: 'FIELD_TYPE_MISMATCH',
  writePermissionDenied: 'BASE_WRITE_PERMISSION_DENIED',
  fieldNameNotFound: 'FIELD_NAME_NOT_FOUND',
  writeFailed: 'BASE_WRITE_FAILED',
} as const;

export type EnqueueBaseSyncTaskInput = {
  meetingRecordId: string;
  integrationId: string;
  userId: string;
  projectId?: string | null;
  orgTargetId?: string | null;
  orgName?: string | null;
  appToken?: string | null;
  tableId?: string | null;
  requestedVersion: number;
  mappingVersion?: number | null;
  existingBaseRecordId?: string | null;
};

export function buildTargetKey(projectId?: string | null): string {
  return projectId ? `project:${projectId}` : UNBOUND_TARGET_KEY;
}

export async function getBaseSyncTaskById(
  taskId: string
): Promise<MeetingBaseSyncTaskRow | null> {
  const [row] = await getDb()
    .select()
    .from(meetingBaseSyncTasks)
    .where(eq(meetingBaseSyncTasks.id, taskId))
    .limit(1);
  return row || null;
}

/**
 * 登记 / 推进一个 Base 同步任务。可在事务内执行（传入 drizzle tx）。
 * 返回最新行；冲突已存在时返回的是 UPDATE ... RETURNING 的最新状态。
 */
export async function enqueueBaseSyncTask(
  input: EnqueueBaseSyncTaskInput,
  executor: DeliveryDbExecutor = getDb()
): Promise<MeetingBaseSyncTaskRow | null> {
  const targetKey = buildTargetKey(input.projectId);
  const blocked = !input.projectId || !input.orgTargetId || !input.appToken || !input.tableId;
  const snapshot = JSON.stringify({
    projectId: input.projectId ?? null,
    orgTargetId: input.orgTargetId ?? null,
    orgName: input.orgName ?? null,
    appTokenEncrypted: input.appToken ? encrypt(input.appToken) : null,
    tableId: input.tableId ?? null,
  });

  const result = await executor.execute(sql`
    insert into meeting_base_sync_tasks (
      meeting_record_id, integration_id, user_id, project_id, org_target_id,
      target_key, target_config_snapshot, mapping_version,
      requested_version, synced_version, status, next_run_at,
      base_record_id, last_error_code, last_error_summary,
      created_at, updated_at
    ) values (
      ${input.meetingRecordId}, ${input.integrationId}, ${input.userId},
      ${input.projectId ?? null}, ${input.orgTargetId ?? null},
      ${targetKey}, ${snapshot}::jsonb, ${input.mappingVersion ?? null},
      ${input.requestedVersion}, 0,
      ${blocked ? 'blocked' : 'pending'},
      ${blocked ? null : new Date()},
      ${input.existingBaseRecordId ?? null},
      ${blocked ? BASE_SYNC_ERROR_CODE.targetNotConfigured : null},
      ${blocked ? '会议未绑定目标项目，无法写入 Base，请在初始化时选择组织方向' : null},
      now(), now()
    )
    on conflict (meeting_record_id, target_key) do update set
      requested_version = greatest(excluded.requested_version, meeting_base_sync_tasks.requested_version),
      mapping_version = coalesce(excluded.mapping_version, meeting_base_sync_tasks.mapping_version),
      -- succeeded 后有新版本 → 立即重排队；其余状态（blocked/unknown/cancelled/running/…）保持不动
      status = case
        when meeting_base_sync_tasks.status = 'succeeded'
         and excluded.requested_version > meeting_base_sync_tasks.synced_version
          then 'pending'
        else meeting_base_sync_tasks.status
      end,
      next_run_at = case
        when meeting_base_sync_tasks.status = 'succeeded'
         and excluded.requested_version > meeting_base_sync_tasks.synced_version
          then now()
        else meeting_base_sync_tasks.next_run_at
      end,
      lease_token = case
        when meeting_base_sync_tasks.status = 'succeeded'
         and excluded.requested_version > meeting_base_sync_tasks.synced_version
          then null
        else meeting_base_sync_tasks.lease_token
      end,
      lease_expires_at = case
        when meeting_base_sync_tasks.status = 'succeeded'
         and excluded.requested_version > meeting_base_sync_tasks.synced_version
          then null
        else meeting_base_sync_tasks.lease_expires_at
      end,
      updated_at = now()
    returning *
  `);

  return (result.rows?.[0] ?? null) as MeetingBaseSyncTaskRow | null;
}

/** 执行器写回 base_record_id（成功找到/创建记录后），带租约保护 */
export async function updateBaseSyncTaskRecordId(
  taskId: string,
  leaseToken: string,
  baseRecordId: string,
  executor: DeliveryDbExecutor = getDb()
): Promise<void> {
  await executor.execute(sql`
    update meeting_base_sync_tasks
    set base_record_id = ${baseRecordId}, updated_at = now()
    where id = ${taskId} and lease_token = ${leaseToken}
  `);
}

export { DELIVERY_TABLE };
