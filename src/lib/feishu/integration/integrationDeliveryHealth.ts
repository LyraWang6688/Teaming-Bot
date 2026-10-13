/**
 * 事件投递存活监测。
 *
 * ## 背景
 *
 * 飞书将于 **2026-10-26** 调整「用户身份订阅事件」的投递鉴权逻辑：
 * 投递前会校验 (a) 事件所属用户是否已向应用授予对应权限、
 * (b) 该用户是否在应用可用范围内——**两项都过才投递**。
 *
 * 变更前的行为是"只看应用申请了什么权限"，所以即使某个用户授权已经失效，
 * 事件照样会送进来、照样能入队成 `blocked` 任务，事后再补发即可。
 *
 * **变更后，授权失效 = 事件直接不投递 = 这场会议彻底丢失、无法补发。**
 *
 * 飞书同时要求："应用已妥善处理事件停止投递的情况，避免影响业务流程"。
 * 本项目此前**完全没有**这类监测——2026-09-30 的 13 天静默停摆就是这么被掩盖的。
 *
 * ## 监测什么
 *
 * 1. **授权健康**（强信号）：active 集成若授权非 authorized，或 refresh token 即将到期，
 *    则事件随时会停止投递。这是变更后唯一可提前发现的征兆。
 * 2. **事件到达情况**（弱信号）：长时间没有任何事件入队。
 *    注意这会**误报**——团队放假没有会议本来就该没有事件。
 *    所以它只作为 warn，不作为 error。
 */

import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { meetingPipelineTasks } from '@/lib/db/schema';
import {
  getLatestFeishuAuthorizationContext,
  listActiveFeishuIntegrationContextsWithBase,
  writeAuditLog,
} from './integrationStore';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { sendOpsAlert } from '../ops/opsAlertService';

export const DEFAULT_EXPIRING_SOON_DAYS = 3;
export const DEFAULT_QUIET_DAYS = 7;

export type DeliveryHealthLevel = 'ok' | 'warn' | 'error';

export type DeliveryHealthVerdict = {
  level: DeliveryHealthLevel;
  reasonCode: string;
  message: string;
};

export type DeliveryHealthSweepSummary = {
  scanned: number;
  ok: number;
  warn: number;
  error: number;
  warnings: Array<{ integrationId: string; level: DeliveryHealthLevel; reasonCode: string }>;
  durationMs: number;
};

/**
 * 判定单个集成的投递健康度。纯函数，便于测试。
 *
 * 判定顺序体现优先级：授权问题（事件会彻底断）> 令牌将到期 > 长时间无事件（可能只是没开会）。
 */
export function classifyDeliveryHealth(input: {
  authorizationStatus: string | null;
  refreshTokenExpiresAt: Date | null;
  daysSinceLastEvent: number | null;
  now: Date;
  expiringSoonDays?: number;
  quietDays?: number;
}): DeliveryHealthVerdict {
  const expiringSoonDays = input.expiringSoonDays ?? DEFAULT_EXPIRING_SOON_DAYS;
  const quietDays = input.quietDays ?? DEFAULT_QUIET_DAYS;

  if (!input.authorizationStatus) {
    return {
      level: 'error',
      reasonCode: 'authorization_missing',
      message: '集成没有用户授权记录。2026-10-26 起该用户的事件将不再投递。',
    };
  }

  if (input.authorizationStatus !== 'authorized') {
    return {
      level: 'error',
      reasonCode: 'authorization_invalid',
      message: `授权状态为 ${input.authorizationStatus}。2026-10-26 起该用户的事件将不再投递，需尽快重新授权。`,
    };
  }

  if (input.refreshTokenExpiresAt) {
    const remainingMs = input.refreshTokenExpiresAt.getTime() - input.now.getTime();
    const remainingDays = remainingMs / (24 * 60 * 60 * 1000);
    if (remainingMs <= 0) {
      return {
        level: 'error',
        reasonCode: 'refresh_token_expired',
        message: 'Refresh Token 已过期，事件随时会停止投递。',
      };
    }
    if (remainingDays <= expiringSoonDays) {
      return {
        level: 'warn',
        reasonCode: 'refresh_token_expiring_soon',
        message: `Refresh Token 剩余约 ${remainingDays.toFixed(1)} 天，主动刷新调度器应当尽快续期。`,
      };
    }
  }

  if (input.daysSinceLastEvent === null) {
    return {
      level: 'warn',
      reasonCode: 'no_event_ever',
      message: '该集成从未收到过任何事件。若长期如此，需确认事件订阅是否真的生效。',
    };
  }

  if (input.daysSinceLastEvent > quietDays) {
    return {
      level: 'warn',
      reasonCode: 'no_event_for_a_while',
      message: `已 ${input.daysSinceLastEvent.toFixed(1)} 天没有事件。若期间确有会议，说明投递可能已中断；若确实没有会议，可忽略。`,
    };
  }

  return { level: 'ok', reasonCode: 'healthy', message: '授权有效且事件投递正常。' };
}

/**
 * 每个 reasonCode 对应的「该怎么办」。
 *
 * 告警只报错没有意义——收到的人必须知道下一步动作。
 */
const REASON_GUIDANCE: Record<string, string> = {
  authorization_missing: '该集成没有用户授权记录，需先完成初始化。',
  authorization_invalid:
    '**需用户重新授权**。若该应用被飞书管控策略拒绝（21001，表现为「当前账号无法使用该应用」），需先在开发者后台配置**可用范围**并发布版本。',
  refresh_token_expired:
    '令牌已过期且无法自愈。在 85 天补发窗口内可重新授权后自动补发；超出窗口的会议不再补发。',
  refresh_token_expiring_soon: '主动刷新调度器会处理；若持续告警说明续期失败，需查应用凭证。',
  no_event_ever: '该集成从未收到过事件。确认是否有带妙记录制的会议，以及事件订阅是否生效。',
  no_event_for_a_while:
    '长时间无事件。若期间确有会议，说明投递可能已中断（**2026-10-26 起未授权用户不再投递且无法补发**）；若确实没有会议可忽略。',
  health_check_failed: '健康检查本身失败，需查看日志。',
};

/**
 * 把扫描结果整理成可读告警。无异常时返回 null（不发无意义的消息）。
 *
 * 纯函数，便于测试。
 */
export function buildDeliveryHealthAlert(
  summary: DeliveryHealthSweepSummary
): { title: string; markdown: string } | null {
  if (summary.error === 0 && summary.warn === 0) return null;

  const byReason = new Map<string, number>();
  for (const item of summary.warnings) {
    byReason.set(item.reasonCode, (byReason.get(item.reasonCode) ?? 0) + 1);
  }

  const lines: string[] = [
    `**事件投递健康检查**：扫描 ${summary.scanned} 个集成`,
    `🔴 异常 ${summary.error} ／ 🟡 告警 ${summary.warn} ／ ✅ 正常 ${summary.ok}`,
    '',
  ];

  const ordered = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reasonCode, count] of ordered) {
    lines.push(`**${reasonCode}** × ${count}`);
    const guidance = REASON_GUIDANCE[reasonCode];
    if (guidance) lines.push(`> ${guidance}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(
    '**为什么现在就要处理**：飞书 2026-10-26 起，未授权用户的事件将不再投递，届时这些集成的会议会**直接丢失且无法补发**。'
  );

  return {
    title: '⚠️ 事件投递健康检查发现异常',
    markdown: lines.join('\n'),
  };
}

/** 一次性取出所有集成的最近事件时间（避免 N+1） */
async function getLastEventAtByIntegration(): Promise<Map<string, Date>> {
  const db = getDb();
  const rows = await db
    .select({
      integrationId: meetingPipelineTasks.integrationId,
      lastEventAt: sql<Date | null>`max(${meetingPipelineTasks.createdAt})`,
    })
    .from(meetingPipelineTasks)
    .groupBy(meetingPipelineTasks.integrationId);

  const result = new Map<string, Date>();
  for (const row of rows) {
    if (row.lastEventAt) result.set(row.integrationId, new Date(row.lastEventAt));
  }
  return result;
}

/**
 * 扫描所有 active 集成，输出投递健康报告。
 *
 * 单个集成检查失败不影响整体。
 */
export async function sweepIntegrationDeliveryHealth(
  options: { now?: Date; expiringSoonDays?: number; quietDays?: number } = {}
): Promise<DeliveryHealthSweepSummary> {
  const now = options.now ?? new Date();
  const startedAt = Date.now();

  const summary: DeliveryHealthSweepSummary = {
    scanned: 0,
    ok: 0,
    warn: 0,
    error: 0,
    warnings: [],
    durationMs: 0,
  };

  const integrations = await listActiveFeishuIntegrationContextsWithBase();

  let lastEventAtByIntegration = new Map<string, Date>();
  try {
    lastEventAtByIntegration = await getLastEventAtByIntegration();
  } catch (error) {
    logFeishuMonitor('error', 'event_delivery_health_last_event_query_failed', toErrorContext(error));
  }

  for (const integration of integrations) {
    summary.scanned += 1;

    try {
      const authorization = await getLatestFeishuAuthorizationContext(integration.id);
      const lastEventAt = lastEventAtByIntegration.get(integration.id) ?? null;
      const daysSinceLastEvent = lastEventAt
        ? (now.getTime() - lastEventAt.getTime()) / (24 * 60 * 60 * 1000)
        : null;

      const verdict = classifyDeliveryHealth({
        authorizationStatus: authorization?.status ?? null,
        refreshTokenExpiresAt: authorization?.refreshTokenExpiresAt ?? null,
        daysSinceLastEvent,
        now,
        expiringSoonDays: options.expiringSoonDays,
        quietDays: options.quietDays,
      });

      if (verdict.level === 'ok') summary.ok += 1;
      else if (verdict.level === 'warn') summary.warn += 1;
      else summary.error += 1;

      if (verdict.level !== 'ok') {
        summary.warnings.push({
          integrationId: integration.id,
          level: verdict.level,
          reasonCode: verdict.reasonCode,
        });
        logFeishuMonitor(verdict.level === 'error' ? 'error' : 'warn', 'event_delivery_health_warning', {
          integrationId: integration.id,
          userId: integration.userId,
          reasonCode: verdict.reasonCode,
          message: verdict.message,
          daysSinceLastEvent,
        });
      }
    } catch (error) {
      summary.error += 1;
      summary.warnings.push({
        integrationId: integration.id,
        level: 'error',
        reasonCode: 'health_check_failed',
      });
      logFeishuMonitor('error', 'event_delivery_health_check_failed', {
        integrationId: integration.id,
        ...toErrorContext(error),
      });
    }
  }

  summary.durationMs = Date.now() - startedAt;

  logFeishuMonitor('info', 'event_delivery_health_sweep_completed', {
    scanned: summary.scanned,
    ok: summary.ok,
    warn: summary.warn,
    error: summary.error,
    durationMs: summary.durationMs,
    warnings: summary.warnings.slice(0, 30),
  });

  try {
    await writeAuditLog({
      userId: null,
      integrationId: null,
      action: 'integration.event_delivery_health_swept',
      result: summary.error > 0 ? 'failed' : summary.warn > 0 ? 'partial' : 'success',
      summary: `事件投递健康检查：扫描 ${summary.scanned}，正常 ${summary.ok}，告警 ${summary.warn}，异常 ${summary.error}`,
      metadata: {
        scanned: summary.scanned,
        ok: summary.ok,
        warn: summary.warn,
        error: summary.error,
        durationMs: summary.durationMs,
      },
    });
  } catch (error) {
    logFeishuMonitor('error', 'event_delivery_health_audit_failed', toErrorContext(error));
  }

  // 审计表是兜底（推送哑了也能查）；推送是"人能看到"的那一层。
  // 推送永不抛错，失败只记日志。
  const alert = buildDeliveryHealthAlert(summary);
  if (alert) {
    await sendOpsAlert({ title: alert.title, markdown: alert.markdown });
  }

  return summary;
}
