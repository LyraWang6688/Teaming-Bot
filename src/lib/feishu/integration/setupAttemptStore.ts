/**
 * 飞书初始化尝试（setup attempts）持久化
 *
 * 设计：
 * - 一次「从开始配置到全部检查通过/放弃」的初始化过程对应一个 setup_trace_id
 * - 同一集成同一轮内的多次 checks 轮询复用进行中的 attempt，只刷新进度与 state_version
 * - 终态：succeeded / waiting_user（等用户继续操作，非终态）/ failed / interrupted / expired / cancelled
 * - 所有状态落库，可重启恢复、可在 ops.ops_setup_attempt_overview 排查
 */
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db/client';
import {
  feishuIntegrations,
  feishuSetupAttempts,
} from '@/lib/db/schema';

export const SETUP_ATTEMPT_STATUS = {
  running: 'running',
  waitingUser: 'waiting_user',
  succeeded: 'succeeded',
  failed: 'failed',
  expired: 'expired',
  interrupted: 'interrupted',
  cancelled: 'cancelled',
} as const;

export type SetupAttemptStatus =
  (typeof SETUP_ATTEMPT_STATUS)[keyof typeof SETUP_ATTEMPT_STATUS];

type ActiveSetupAttemptRow = typeof feishuSetupAttempts.$inferSelect;

async function findActiveAttempt(
  integrationId: string
): Promise<ActiveSetupAttemptRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(feishuSetupAttempts)
    .where(
      and(
        eq(feishuSetupAttempts.integrationId, integrationId),
        inArray(feishuSetupAttempts.status, ['running', 'waiting_user'])
      )
    )
    .orderBy(desc(feishuSetupAttempts.updatedAt))
    .limit(1);
  return row ?? null;
}

export type StartOrTouchInput = {
  userId: string;
  integrationId: string;
  projectId?: string | null;
  orgTargetId?: string | null;
  /** 当前检查执行到的步骤（create_app/oauth/org_target/permission/minute_subscription/event_listener） */
  currentStep: string;
};

/**
 * 检查开始时登记心跳：
 * 有进行中的 attempt → 复用并推进；否则新建一轮 attempt。
 */
export async function startOrTouchSetupAttempt(
  input: StartOrTouchInput
): Promise<{ setupTraceId: string; reused: boolean }> {
  const db = getDb();
  const now = new Date();
  const active = await findActiveAttempt(input.integrationId);

  if (active) {
    await db
      .update(feishuSetupAttempts)
      .set({
        status: 'running',
        currentStep: input.currentStep,
        stepStartedAt: now,
        lastProgressAt: now,
        finishedAt: null,
        endReason: null,
        stateVersion: sql`${feishuSetupAttempts.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(eq(feishuSetupAttempts.id, active.id));
    return { setupTraceId: active.setupTraceId, reused: true };
  }

  const setupTraceId = `setup:${input.integrationId}:${randomUUID()}`;
  await db.insert(feishuSetupAttempts).values({
    userId: input.userId,
    integrationId: input.integrationId,
    projectId: input.projectId ?? null,
    orgTargetId: input.orgTargetId ?? null,
    setupTraceId,
    currentStep: input.currentStep,
    status: 'running',
    stepStartedAt: now,
    lastProgressAt: now,
    stateVersion: 1,
    updatedAt: now,
  });

  return { setupTraceId, reused: false };
}

export type ResolveSetupCheckInput = {
  integrationId: string;
  currentStep: string;
  allPassed: boolean;
  /** 未通过时的首要阻塞门（作为 next_action_code） */
  blockerCode?: string | null;
  errorCode?: string | null;
  errorSummary?: string | null;
  endReason?: string | null;
};

/**
 * 一轮 checks 执行完毕后的状态落定：
 * - 全部通过 → succeeded
 * - 有未通过/待办项 → waiting_user（保留 attempt 活跃，等下一次轮询继续）
 */
export async function resolveSetupAttemptAfterChecks(
  input: ResolveSetupCheckInput
): Promise<void> {
  const db = getDb();
  const active = await findActiveAttempt(input.integrationId);
  if (!active) return;
  const now = new Date();

  if (input.allPassed) {
    await db
      .update(feishuSetupAttempts)
      .set({
        status: 'succeeded',
        currentStep: input.currentStep,
        lastProgressAt: now,
        finishedAt: now,
        nextActionCode: null,
        lastErrorCode: null,
        lastErrorSummary: null,
        endReason: input.endReason ?? 'all_checks_passed',
        stateVersion: sql`${feishuSetupAttempts.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(eq(feishuSetupAttempts.id, active.id));
    return;
  }

  await db
    .update(feishuSetupAttempts)
    .set({
      status: 'waiting_user',
      currentStep: input.currentStep,
      lastProgressAt: now,
      nextActionCode: input.blockerCode ?? null,
      lastErrorCode: input.errorCode ?? null,
      lastErrorSummary: input.errorSummary ?? null,
      stateVersion: sql`${feishuSetupAttempts.stateVersion} + 1`,
      updatedAt: now,
    })
    .where(eq(feishuSetupAttempts.id, active.id));
}

/** 检查执行抛异常（非业务未通过）：进行中的 attempt 置 interrupted */
export async function interruptActiveSetupAttempt(
  integrationId: string,
  errorSummary: string
): Promise<void> {
  const db = getDb();
  const active = await findActiveAttempt(integrationId);
  if (!active) return;
  const now = new Date();
  await db
    .update(feishuSetupAttempts)
    .set({
      status: 'interrupted',
      finishedAt: now,
      lastProgressAt: now,
      lastErrorCode: 'CHECK_RUN_THREW',
      lastErrorSummary: errorSummary.slice(0, 500),
      endReason: 'check_run_threw',
      stateVersion: sql`${feishuSetupAttempts.stateVersion} + 1`,
      updatedAt: now,
    })
    .where(eq(feishuSetupAttempts.id, active.id));
}

/**
 * 首次完成事实：只写一次。
 * 集成被替换/重新初始化都不覆盖该时间与证据。
 * 返回 true 表示本次是首次写入。
 */
export async function markFirstInitializedOnce(
  integrationId: string,
  evidence: string
): Promise<boolean> {
  const db = getDb();
  const result = await db
    .update(feishuIntegrations)
    .set({
      firstInitializedAt: new Date(),
      firstInitializedEvidence: evidence,
    })
    .where(
      and(
        eq(feishuIntegrations.id, integrationId),
        isNull(feishuIntegrations.firstInitializedAt)
      )
    )
    .returning({ id: feishuIntegrations.id });

  return result.length > 0;
}

/**
 * 启动恢复：进程崩溃后停留在 running 的 attempt（超过 staleMs 无进度）置 interrupted。
 * waiting_user 不属于崩溃态（用户尚未完成操作），不处理。
 */
export async function recoverStaleSetupAttempts(options?: {
  staleMs?: number;
}): Promise<number> {
  const staleMs = options?.staleMs ?? 10 * 60 * 1000;
  const db = getDb();
  const cutoff = new Date(Date.now() - staleMs);
  const rows = await db
    .update(feishuSetupAttempts)
    .set({
      status: 'interrupted',
      finishedAt: new Date(),
      endReason: 'stale_running_on_recover',
      stateVersion: sql`${feishuSetupAttempts.stateVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(feishuSetupAttempts.status, 'running'),
        lt(feishuSetupAttempts.lastProgressAt, cutoff)
      )
    )
    .returning({ id: feishuSetupAttempts.id });
  return rows.length;
}

/** 根据 checks 状态推导当前进行到的步骤（用于 attempt.current_step / next_action_code） */
export function deriveSetupCurrentStep(statuses: {
  appCredentialStatus: string;
  oauthStatus: string;
  permissionStatus: string;
  minuteSubscriptionStatus: string;
  eventSubscriptionStatus: string;
}): string {
  if (statuses.appCredentialStatus !== 'success') return 'create_app';
  if (statuses.oauthStatus !== 'authorized') return 'oauth';
  if (statuses.permissionStatus !== 'success') return 'permission';
  if (statuses.minuteSubscriptionStatus !== 'success') return 'minute_subscription';
  if (statuses.eventSubscriptionStatus !== 'success') return 'event_listener';
  return 'event_listener';
}
