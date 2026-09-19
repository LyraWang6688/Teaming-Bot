/**
 * 通用交付任务基础设施（Base 同步 / 报告通知共用）
 *
 * 7 态状态机：pending / running / retry_wait / succeeded / blocked / unknown / cancelled
 * - 领取：SKIP LOCKED 原子抢占，发 lease_token + lease_expires_at
 * - 续租：执行期间心跳续租；崩溃后租约到期，任务可被其他实例重新领取
 * - 退避：30s / 1m / 2m / 5m（带抖动），最多 5 次，超限 blocked
 * - blocked：明确不可继续（配置缺失、权限拒绝、字段未绑定），只记录不重投
 * - unknown：请求结果未知（网络/超时），不盲目重发，保留现场供人工核对
 *
 * 进程重启恢复不需要单独的 startup 扫描：worker 领取器同时领取
 * pending / retry_wait 到期任务与 lease 过期的 running 任务。
 */
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';

export const DELIVERY_TASK_STATUS = {
  pending: 'pending',
  running: 'running',
  retryWait: 'retry_wait',
  succeeded: 'succeeded',
  blocked: 'blocked',
  unknown: 'unknown',
  cancelled: 'cancelled',
} as const;

export type DeliveryTaskStatus =
  (typeof DELIVERY_TASK_STATUS)[keyof typeof DELIVERY_TASK_STATUS];

/** 只允许这两张表走通用原语，表名永远不接受外部动态输入 */
export const DELIVERY_TABLE = {
  baseSync: 'meeting_base_sync_tasks',
  notification: 'meeting_report_notification_tasks',
} as const;

export type DeliveryTableName = (typeof DELIVERY_TABLE)[keyof typeof DELIVERY_TABLE];

/** 可在事务内执行的最小 DB 接口（getDb() 与 drizzle 事务 tx 均满足） */
export type DeliveryDbExecutor = Pick<ReturnType<typeof getDb>, 'execute'>;

export const DELIVERY_MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];
const RETRY_JITTER_RATIO = 0.1;

/** 租约时长与心跳间隔（worker 按此续租） */
export const DELIVERY_LEASE_TTL_MS = Number(
  process.env.FEISHU_DELIVERY_LEASE_TTL_MS || 2 * 60_000
);
const STALE_LEASE_MS = Number(
  process.env.FEISHU_DELIVERY_STALE_LEASE_MS || 5 * 60_000
);

export function computeRetryDelayMs(attemptCountAfterClaim: number): number {
  const base =
    RETRY_DELAYS_MS[Math.min(attemptCountAfterClaim - 1, RETRY_DELAYS_MS.length - 1)];
  const jitter = base * RETRY_JITTER_RATIO * Math.random();
  return Math.round(base + jitter);
}

function tableIdentifier(table: DeliveryTableName) {
  if (!Object.values(DELIVERY_TABLE).includes(table)) {
    throw new Error(`非法交付任务表：${String(table)}`);
  }
  return sql.identifier(table);
}

export type ClaimOptions = {
  limit?: number;
  staleLockBefore?: Date;
  leaseTtlMs?: number;
};

/**
 * 原子领取到期任务：
 * - pending / retry_wait 且 next_run_at 到期
 * - running 但租约已过期（崩溃恢复）
 * SKIP LOCKED 保证多实例/多 worker 并发安全。
 */
export async function claimDueDeliveryTasks<T extends Record<string, unknown>>(
  db: DeliveryDbExecutor,
  table: DeliveryTableName,
  options: ClaimOptions = {}
): Promise<T[]> {
  const limit = Math.max(options.limit ?? 3, 1);
  const staleLockBefore = options.staleLockBefore ?? new Date(Date.now() - STALE_LEASE_MS);
  const leaseTtlSeconds = Math.round((options.leaseTtlMs ?? DELIVERY_LEASE_TTL_MS) / 1000);
  const leaseToken = randomUUID();
  const t = tableIdentifier(table);

  const result = await db.execute(sql`
    update ${t} as task
    set status = 'running',
        lease_token = ${leaseToken},
        lease_expires_at = now() + make_interval(secs => ${leaseTtlSeconds}),
        attempt_count = task.attempt_count + 1,
        last_attempt_at = now(),
        next_run_at = null,
        updated_at = now()
    where task.id in (
      select candidate.id
      from ${t} as candidate
      where (
              candidate.status in ('pending', 'retry_wait')
          and coalesce(candidate.next_run_at, now()) <= now()
        )
         or (
              candidate.status = 'running'
          and (
                candidate.lease_token is null
             or candidate.lease_expires_at is null
             or candidate.lease_expires_at <= ${staleLockBefore}
          )
        )
      order by coalesce(candidate.next_run_at, now()) asc, candidate.updated_at asc
      limit ${limit}
      for update skip locked
    )
    returning *
  `);

  return (result.rows ?? []) as T[];
}

type LeaseGuard = { id: string; leaseToken: string };

/** 续租（心跳）。返回 false 表示租约已丢失（被超时回收），执行器应主动停止。 */
export async function renewDeliveryLease(
  db: DeliveryDbExecutor,
  table: DeliveryTableName,
  task: LeaseGuard,
  leaseTtlMs = DELIVERY_LEASE_TTL_MS
): Promise<boolean> {
  const t = tableIdentifier(table);
  const leaseSeconds = Math.round(leaseTtlMs / 1000);
  const result = await db.execute(sql`
    update ${t}
    set lease_expires_at = now() + make_interval(secs => ${leaseSeconds})
    where id = ${task.id} and lease_token = ${task.leaseToken}
  `);
  return (result.rowCount ?? 0) > 0;
}

export type SucceedPatch = {
  baseRecordId?: string;
  syncedVersion?: number;
  partial?: boolean;
  messageId?: string;
};

/** 成功完成；base 表额外写 synced_version / base_record_id / partial，通知表写 message_id / sent_at */
export async function completeDeliveryTask(
  db: DeliveryDbExecutor,
  table: DeliveryTableName,
  task: LeaseGuard,
  patch?: SucceedPatch
): Promise<void> {
  const t = tableIdentifier(table);
  const baseExtra =
    table === DELIVERY_TABLE.baseSync
      ? sql`
          synced_version = coalesce(${patch?.syncedVersion ?? null}, synced_version),
          partial = coalesce(${patch?.partial ?? null}, partial),
          base_record_id = coalesce(${patch?.baseRecordId ?? null}, base_record_id),
          last_succeeded_at = now()
        `
      : sql`
          message_id = coalesce(${patch?.messageId ?? null}, message_id),
          sent_at = now()
        `;

  await db.execute(sql`
    update ${t}
    set status = 'succeeded',
        next_run_at = null,
        lease_token = null,
        lease_expires_at = null,
        last_error_code = null,
        last_error_summary = null,
        ${baseExtra},
        updated_at = now()
    where id = ${task.id} and lease_token = ${task.leaseToken}
  `);
}

/**
 * 一次尝试失败：可重试 → retry_wait + 退避；超过上限 → blocked。
 * 返回最终状态。
 */
export async function failDeliveryAttempt(
  db: DeliveryDbExecutor,
  table: DeliveryTableName,
  task: LeaseGuard & { attemptCount: number },
  outcome: {
    retryable: boolean;
    errorCode: string;
    errorSummary: string;
  }
): Promise<'retry_wait' | 'blocked'> {
  if (outcome.retryable && task.attemptCount < DELIVERY_MAX_ATTEMPTS) {
    const delayMs = computeRetryDelayMs(task.attemptCount + 1);
    const nextRunAt = new Date(Date.now() + delayMs);
    const ok = await leaseTransition(
      db,
      table,
      task,
      sql`status = 'retry_wait'`,
      sql`
        next_run_at = ${nextRunAt},
        lease_token = null,
        lease_expires_at = null,
        last_error_code = ${outcome.errorCode},
        last_error_summary = ${outcome.errorSummary}
      `
    );
    return ok ? 'retry_wait' : 'blocked';
  }

  await leaseTransition(
    db,
    table,
    task,
    sql`status = 'blocked'`,
    sql`
      next_run_at = null,
      lease_token = null,
      lease_expires_at = null,
      last_error_code = ${outcome.errorCode},
      last_error_summary = ${outcome.errorSummary}
    `
  );
  return 'blocked';
}

export async function markDeliveryBlocked(
  db: DeliveryDbExecutor,
  table: DeliveryTableName,
  task: LeaseGuard,
  errorCode: string,
  errorSummary: string
): Promise<boolean> {
  return leaseTransition(
    db,
    table,
    task,
    sql`status = 'blocked'`,
    sql`
      next_run_at = null,
      lease_token = null,
      lease_expires_at = null,
      last_error_code = ${errorCode},
      last_error_summary = ${errorSummary}
    `
  );
}

/** 请求结果未知（网络/超时）：置 unknown，不自动重发，保留现场供人工核对 */
export async function markDeliveryUnknown(
  db: DeliveryDbExecutor,
  table: DeliveryTableName,
  task: LeaseGuard,
  errorCode: string,
  errorSummary: string
): Promise<boolean> {
  return leaseTransition(
    db,
    table,
    task,
    sql`status = 'unknown'`,
    sql`
      next_run_at = null,
      lease_token = null,
      lease_expires_at = null,
      last_error_code = ${errorCode},
      last_error_summary = ${errorSummary}
    `
  );
}

/** 版本落后：base 任务已同步旧版本但请求版本更新 → 立即重新排队 */
export async function requeueDeliveryTask(
  db: DeliveryDbExecutor,
  table: DeliveryTableName,
  task: LeaseGuard
): Promise<boolean> {
  return leaseTransition(
    db,
    table,
    task,
    sql`status = 'pending'`,
    sql`
      next_run_at = now(),
      lease_token = null,
      lease_expires_at = null
    `
  );
}

export async function cancelDeliveryTask(
  db: DeliveryDbExecutor,
  table: DeliveryTableName,
  task: LeaseGuard,
  reason: string
): Promise<boolean> {
  return leaseTransition(
    db,
    table,
    task,
    sql`status = 'cancelled'`,
    sql`
      next_run_at = null,
      lease_token = null,
      lease_expires_at = null,
      last_error_code = 'CANCELLED',
      last_error_summary = ${reason}
    `
  );
}

async function leaseTransition(
  db: DeliveryDbExecutor,
  table: DeliveryTableName,
  task: LeaseGuard,
  statusSet: ReturnType<typeof sql>,
  restSet: ReturnType<typeof sql>
): Promise<boolean> {
  const t = tableIdentifier(table);
  const result = await db.execute(sql`
    update ${t}
    set ${statusSet}, ${restSet}, updated_at = now()
    where id = ${task.id} and lease_token = ${task.leaseToken}
  `);
  return (result.rowCount ?? 0) > 0;
}

/** 启动续租心跳；返回 stop 函数。租约丢失时触发 onLost。 */
export function startLeaseHeartbeat(options: {
  db: DeliveryDbExecutor;
  table: DeliveryTableName;
  task: LeaseGuard;
  intervalMs?: number;
  leaseTtlMs?: number;
  onLost?: () => void;
}): () => void {
  const intervalMs = options.intervalMs ?? Math.round(DELIVERY_LEASE_TTL_MS / 2);
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    renewDeliveryLease(options.db, options.table, options.task, options.leaseTtlMs)
      .then((alive) => {
        if (!alive) options.onLost?.();
      })
      .catch(() => {
        // 续租失败（如瞬时 DB 抖动）等下一次心跳；租约 TTL 是 2 倍间隔，有一次容错
      });
  }, intervalMs);
  // 不阻止进程退出
  if (typeof timer.unref === 'function') timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
