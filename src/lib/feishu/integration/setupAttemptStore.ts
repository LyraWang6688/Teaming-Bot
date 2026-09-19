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

export type SetupAttemptToken = { id: string; stateVersion: number; setupTraceId: string };

export async function getActiveSetupAttemptToken(integrationId: string): Promise<SetupAttemptToken | null> {
  const [row] = await getDb().select().from(feishuSetupAttempts).where(and(
    eq(feishuSetupAttempts.integrationId, integrationId),
    inArray(feishuSetupAttempts.status, ['running', 'waiting_user'])
  )).orderBy(desc(feishuSetupAttempts.updatedAt)).limit(1);
  return row ? { id: row.id, stateVersion: row.stateVersion, setupTraceId: row.setupTraceId } : null;
}

export type StartOrTouchInput = {
  userId: string;
  integrationId: string;
  projectId?: string | null;
  orgTargetId?: string | null;
  currentStep: string;
};

/** 每次检查领取一个版本；观察并不代表步骤有进展。 */
export async function startOrTouchSetupAttempt(input: StartOrTouchInput): Promise<SetupAttemptToken> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.integrationId}, 0))`);
    const [active] = await tx.select().from(feishuSetupAttempts).where(and(
      eq(feishuSetupAttempts.integrationId, input.integrationId),
      inArray(feishuSetupAttempts.status, ['running', 'waiting_user'])
    )).orderBy(desc(feishuSetupAttempts.updatedAt)).limit(1).for('update');
    const now = new Date();
    const [row] = active ? await tx.update(feishuSetupAttempts).set({
      stateVersion: sql`${feishuSetupAttempts.stateVersion} + 1`,
      projectId: input.projectId ?? active.projectId,
      orgTargetId: input.orgTargetId ?? active.orgTargetId,
      updatedAt: now,
    }).where(eq(feishuSetupAttempts.id, active.id)).returning()
    : await tx.insert(feishuSetupAttempts).values({
      ...input, setupTraceId: `setup:${randomUUID()}`, status: 'running',
      lastProgressAt: now, stepStartedAt: now, updatedAt: now,
    }).returning();
    return { id: row.id, stateVersion: row.stateVersion, setupTraceId: row.setupTraceId };
  });
}

export type ResolveSetupCheckInput = {
  integrationId: string;
  attempt: SetupAttemptToken;
  currentStep: string;
  allPassed: boolean;
  blockerCode?: string | null;
  errorCode?: string | null;
  errorSummary?: string | null;
  endReason?: string | null;
};

/** 只接受本次检查领取的版本，迟到结果不能覆盖另一轮检查/尝试。 */
export async function resolveSetupAttemptAfterChecks(input: ResolveSetupCheckInput): Promise<boolean> {
  const now = new Date();
  const status = input.allPassed ? 'succeeded' : 'waiting_user';
  const [row] = await getDb().update(feishuSetupAttempts).set({
    status, currentStep: input.currentStep,
    stepStartedAt: sql`case when ${feishuSetupAttempts.currentStep} is distinct from ${input.currentStep}
      then ${now} else ${feishuSetupAttempts.stepStartedAt} end`,
    lastProgressAt: sql`case when ${feishuSetupAttempts.currentStep} is distinct from ${input.currentStep}
      or ${feishuSetupAttempts.status} is distinct from ${status}
      then ${now} else ${feishuSetupAttempts.lastProgressAt} end`,
    finishedAt: input.allPassed ? now : null,
    nextActionCode: input.allPassed ? null : input.blockerCode ?? null,
    lastErrorCode: input.allPassed ? null : input.errorCode ?? null,
    lastErrorSummary: input.allPassed ? null : input.errorSummary ?? null,
    endReason: input.allPassed ? input.endReason ?? 'all_checks_passed' : null,
    stateVersion: sql`${feishuSetupAttempts.stateVersion} + 1`, updatedAt: now,
  }).where(and(
    eq(feishuSetupAttempts.id, input.attempt.id),
    eq(feishuSetupAttempts.integrationId, input.integrationId),
    eq(feishuSetupAttempts.stateVersion, input.attempt.stateVersion),
    inArray(feishuSetupAttempts.status, ['running', 'waiting_user'])
  )).returning({ id: feishuSetupAttempts.id });
  return Boolean(row);
}

export async function interruptActiveSetupAttempt(attempt: SetupAttemptToken): Promise<void> {
  await getDb().update(feishuSetupAttempts).set({
    status: 'interrupted', finishedAt: new Date(), endReason: 'check_run_threw',
    lastErrorCode: 'CHECK_RUN_THREW', lastErrorSummary: '检查中断，初始化结果未确认，请重新检查。',
    nextActionCode: 'retry_checks', stateVersion: sql`${feishuSetupAttempts.stateVersion} + 1`,
    updatedAt: new Date(),
  }).where(and(eq(feishuSetupAttempts.id, attempt.id),
    eq(feishuSetupAttempts.stateVersion, attempt.stateVersion),
    inArray(feishuSetupAttempts.status, ['running', 'waiting_user'])));
}

/** 在 SDK 创建之前保存；session 只存 hash，不持久化创建密钥。 */
export async function beginRegistrationAttempt(userId: string, sessionHash: string, trace?: string): Promise<string> {
  const [row] = await getDb().insert(feishuSetupAttempts).values({
    userId, registrationSessionHash: sessionHash,
    setupTraceId: `${trace?.slice(0, 128) || 'setup'}:${randomUUID()}`,
    currentStep: 'create_app', status: 'running',
    stepStartedAt: new Date(), lastProgressAt: new Date(),
  }).returning({ id: feishuSetupAttempts.id });
  return row.id;
}

export async function resolveRegistrationAttempt(input: {
  attemptId: string; userId: string; integrationId?: string;
  status: 'waiting_user' | 'failed' | 'expired' | 'interrupted';
}): Promise<void> {
  const progressed = Boolean(input.integrationId);
  await getDb().update(feishuSetupAttempts).set({
    integrationId: input.integrationId,
    status: input.status, currentStep: progressed ? 'oauth' : 'create_app',
    lastProgressAt: new Date(), stepStartedAt: new Date(), updatedAt: new Date(),
    finishedAt: input.status === 'waiting_user' ? null : new Date(),
    lastErrorCode: input.status === 'waiting_user' ? null : `REGISTRATION_${input.status.toUpperCase()}`,
    lastErrorSummary: input.status === 'waiting_user' ? null : '创建应用未完成，初始化尚未完成，请重新发起创建。',
    nextActionCode: progressed ? 'authorize' : 'restart_registration',
    stateVersion: sql`${feishuSetupAttempts.stateVersion} + 1`,
  }).where(and(eq(feishuSetupAttempts.id, input.attemptId),
    eq(feishuSetupAttempts.userId, input.userId),
    isNull(feishuSetupAttempts.integrationId),
    inArray(feishuSetupAttempts.status, ['running', 'waiting_user'])));
}

export async function interruptLostRegistration(userId: string, sessionHash: string): Promise<void> {
  await getDb().update(feishuSetupAttempts).set({
    status: 'interrupted', finishedAt: new Date(), endReason: 'registration_session_lost',
    lastErrorCode: 'REGISTRATION_SESSION_LOST', nextActionCode: 'restart_registration',
    lastErrorSummary: '创建会话已中断，尚未完成应用关联，请重新发起。',
    stateVersion: sql`${feishuSetupAttempts.stateVersion} + 1`, updatedAt: new Date(),
  }).where(and(eq(feishuSetupAttempts.userId, userId),
    eq(feishuSetupAttempts.registrationSessionHash, sessionHash),
    isNull(feishuSetupAttempts.integrationId),
    inArray(feishuSetupAttempts.status, ['running', 'waiting_user'])));
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
