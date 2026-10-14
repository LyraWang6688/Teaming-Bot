/**
 * 应用凭证实时校验。
 *
 * ## 为什么需要它
 *
 * `app_credential_status` 原先只在**创建应用**时写一次（`appRegistrationService`），
 * 之后永不更新——是个**历史快照**，不是当前状态。
 *
 * 2026-10-13 的排查中，这个缺口直接导致误判：
 * 数据库显示 `success`，实际调用飞书一律返回
 * `21001 Access denied by access control policy`。
 *
 * 更根本的是：**应用凭证与用户授权是两层完全不同的东西**——
 *
 * ```
 * 应用凭证坏了 → 拿不到 tenant_access_token
 *              → 发提醒、读妙记、写 Base 全部失败
 *              → 用户授权也必然续不上
 * ```
 *
 * 只查授权（表象）会把根因说成"用户没授权"，给出完全错误的处置建议
 * （让用户重新授权——而重新授权根本救不了被管控的应用）。
 *
 * ## 校验方法
 *
 * 就是**真的去取一次 `tenant_access_token`**：
 *
 * ```
 * POST /open-apis/auth/v3/tenant_access_token/internal
 * body: { app_id, app_secret }
 * ```
 *
 * - 只用应用自己的凭证，**不涉及任何用户**
 * - 纯只读，无副作用
 *
 * ## 为什么不用 SDK
 *
 * SDK 会**缓存** tenant_access_token。缓存命中时不会真的请求飞书，
 * 于是"应用已被管控"这种新发生的失效会被旧缓存掩盖 → 校验失去意义。
 * 所以这里直接发 HTTP 请求，保证每次都真实取一次。
 */

import type { FeishuIntegrationContext } from './integrationStore';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';

const TENANT_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const PROBE_TIMEOUT_MS = 15_000;

export type AppCredentialProbeResult =
  | { status: 'success' }
  | { status: 'failed'; errorCode: string; errorMessage: string }
  | { status: 'unknown'; errorCode: string; errorMessage: string };

/**
 * 把飞书的返回码映射为校验结论。纯函数，便于测试。
 *
 * - `0`      → 正常
 * - `21001`  → 被管控策略拒绝（豆包账号这类账号层问题即为此码）
 * - `10014`  → 密钥无效 / 应用不存在
 * - `10217`  → 应用已被删除
 * - 其他     → 明确失败，保留原始码便于排查
 */
export function classifyAppCredentialProbe(
  code: number | null,
  message: string
): AppCredentialProbeResult {
  if (code === 0) return { status: 'success' };

  const errorCode = code === null ? 'probe_failed' : String(code);
  const errorMessage = message || '未知错误';

  return { status: 'failed', errorCode, errorMessage };
}

/**
 * 真实校验一个集成的应用凭证。
 *
 * **不抛错**——校验失败本身就是结论，调用方按 `status` 处理。
 */
export async function probeIntegrationAppCredential(
  integration: Pick<FeishuIntegrationContext, 'id' | 'appId' | 'secrets'>
): Promise<AppCredentialProbeResult> {
  const startedAt = Date.now();
  const appSecret = integration.secrets?.appSecret;

  if (!appSecret) {
    return { status: 'failed', errorCode: 'secret_missing', errorMessage: '应用密钥缺失。' };
  }

  try {
    const response = await fetch(TENANT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: integration.appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    const payload = (await response.json()) as { code?: number; msg?: string };
    const result = classifyAppCredentialProbe(
      typeof payload.code === 'number' ? payload.code : null,
      payload.msg ?? ''
    );

    if (result.status !== 'success') {
      // 注意：只记错误码与文案，绝不打印 app_secret
      logFeishuMonitor('warn', 'app_credential_probe_failed', {
        integrationId: integration.id,
        appId: integration.appId,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        durationMs: Date.now() - startedAt,
      });
    }

    return result;
  } catch (error) {
    // 网络/超时属于"不确定"，不能据此把应用判死
    logFeishuMonitor('warn', 'app_credential_probe_errored', {
      integrationId: integration.id,
      appId: integration.appId,
      ...toErrorContext(error),
    });
    return {
      status: 'unknown',
      errorCode: 'probe_errored',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
