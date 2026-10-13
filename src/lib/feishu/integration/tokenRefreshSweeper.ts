/**
 * 主动刷新调度器：不等业务请求，定期把所有 active 集成的用户授权续期一遍。
 *
 * ## 为什么必须有这个
 *
 * 2026-10-13 复盘发现：飞书的 **refresh token 只有 7 天有效期**，
 * 且只有**实际发生续期**时才会顺延。
 *
 * 而项目里唯一的续期入口 `getValidIntegrationUserAuthorization` 是**惰性**的——
 * 只在 access token（约 2 小时）失效时才续期。也就是说：
 *
 * > **刷新链完全依赖"有业务请求"这件事。**
 *
 * 后果（已实际发生）：worker 于 09-30 卡死 → 13 天没有任务被处理 →
 * 刷新链断裂 → 09-30 刷新的那批 refresh token 在 10-07 全部到期 →
 * 第四期 89% 的授权失效、38 场会议阻塞。
 *
 * 更严重的是飞书将于 **2026-10-26** 调整事件投递鉴权：
 * 用户未授权或不在应用可用范围内时**事件不再投递**。
 * 到那时，"授权过期"不再只是"任务阻塞可恢复"，而是**这场会议彻底丢失、无法补发**。
 *
 * 所以这个调度器是变更后唯一的防线：**保证 refresh token 永远不接近有效期**。
 */

import {
  getLatestFeishuAuthorizationContext,
  listActiveFeishuIntegrationContextsWithBase,
  writeAuditLog,
  type FeishuAuthorizationContext,
} from './integrationStore';
import { getValidIntegrationUserAuthorization } from './tokenService';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';

/** 默认每 6 小时扫一次（远小于 7 天有效期，留足重试余地） */
export const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 默认剩余有效期不足 3 天就主动刷新 */
export const DEFAULT_REFRESH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export type TokenRefreshSweepSummary = {
  scanned: number;
  refreshed: number;
  skipped: number;
  failed: number;
  failures: Array<{ integrationId: string; reason: string }>;
  durationMs: number;
};

/**
 * 判断某个授权是否需要在本次扫描中刷新。
 *
 * 纯函数，便于测试。规则：
 * - 非 authorized 状态不处理（交给"授权失效提醒"链路）
 * - 没有 refresh token 就刷不了
 * - 到期时间未知 → 保守刷新
 * - 到期时间在窗口内 → 刷新
 */
export function shouldRefreshAuthorization(
  authorization: Pick<
    FeishuAuthorizationContext,
    'status' | 'refreshToken' | 'refreshTokenExpiresAt'
  >,
  options: { now: Date; windowMs?: number }
): boolean {
  if (authorization.status !== 'authorized') return false;
  if (!authorization.refreshToken) return false;

  const windowMs = options.windowMs ?? DEFAULT_REFRESH_WINDOW_MS;
  const expiresAt = authorization.refreshTokenExpiresAt;
  if (!expiresAt) return true;

  return expiresAt.getTime() - options.now.getTime() <= windowMs;
}

/**
 * 扫描所有 active 集成，把即将到期的用户授权主动续期。
 *
 * 单个集成失败不影响整体；失败项记录在 summary.failures 里并输出监控事件。
 */
export async function sweepExpiringAuthorizations(
  options: { now?: Date; windowMs?: number } = {}
): Promise<TokenRefreshSweepSummary> {
  const now = options.now ?? new Date();
  const windowMs = options.windowMs ?? DEFAULT_REFRESH_WINDOW_MS;
  const startedAt = Date.now();

  const summary: TokenRefreshSweepSummary = {
    scanned: 0,
    refreshed: 0,
    skipped: 0,
    failed: 0,
    failures: [],
    durationMs: 0,
  };

  const integrations = await listActiveFeishuIntegrationContextsWithBase();

  for (const integration of integrations) {
    summary.scanned += 1;

    let authorization: FeishuAuthorizationContext | null = null;
    try {
      authorization = await getLatestFeishuAuthorizationContext(integration.id);
    } catch (error) {
      summary.failed += 1;
      summary.failures.push({
        integrationId: integration.id,
        reason: error instanceof Error ? error.message : '读取授权失败',
      });
      logFeishuMonitor('error', 'token_refresh_sweep_item_failed', {
        integrationId: integration.id,
        stage: 'read_authorization',
        ...toErrorContext(error),
      });
      continue;
    }

    if (!authorization || !shouldRefreshAuthorization(authorization, { now, windowMs })) {
      summary.skipped += 1;
      continue;
    }

    try {
      // forceRefresh：access token 可能还没过期，但我们要的是让 refresh token 顺延
      await getValidIntegrationUserAuthorization(integration, { forceRefresh: true });
      summary.refreshed += 1;
    } catch (error) {
      summary.failed += 1;
      summary.failures.push({
        integrationId: integration.id,
        reason: error instanceof Error ? error.message : '续期失败',
      });
      logFeishuMonitor('error', 'token_refresh_sweep_item_failed', {
        integrationId: integration.id,
        userId: integration.userId,
        stage: 'refresh',
        ...toErrorContext(error),
      });
    }
  }

  summary.durationMs = Date.now() - startedAt;

  logFeishuMonitor('info', 'token_refresh_sweep_completed', {
    scanned: summary.scanned,
    refreshed: summary.refreshed,
    skipped: summary.skipped,
    failed: summary.failed,
    durationMs: summary.durationMs,
    failures: summary.failures.slice(0, 20),
    windowMs,
  });

  try {
    await writeAuditLog({
      userId: null,
      integrationId: null,
      action: 'oauth.token.refresh_swept',
      result: summary.failed > 0 ? 'partial' : 'success',
      summary: `主动刷新：扫描 ${summary.scanned}，续期 ${summary.refreshed}，跳过 ${summary.skipped}，失败 ${summary.failed}`,
      metadata: {
        scanned: summary.scanned,
        refreshed: summary.refreshed,
        skipped: summary.skipped,
        failed: summary.failed,
        durationMs: summary.durationMs,
        windowMs,
      },
    });
  } catch (error) {
    logFeishuMonitor('error', 'token_refresh_sweep_audit_failed', toErrorContext(error));
  }

  return summary;
}
