/**
 * 宿主接口的鉴权。
 *
 * ## 两级凭证
 *
 * | 凭证 | 用途 | 谁能拿 |
 * |---|---|---|
 * | `HOST_API_TOKEN`（环境变量） | **运营/自用**：给运维脚本、生成接入码用 | 你 |
 * | 宿主凭证（接入码兑换，存库） | **每个用户安装一个**：报告上传用 | 用户 |
 *
 * ## 为什么报告接口优先认宿主凭证
 *
 * 改造前报告接口只认全局 `HOST_API_TOKEN` + 全局 `HOST_REPORT_INTEGRATION_ID`：
 * 所有用户共用一个 token，报告全挂到同一个集成，无法分辨来源。
 *
 * 现在优先解析宿主凭证拿 `integrationId`；解析不到时**回落到全局 token**
 * （自用阶段与已有部署继续可用），并把实际用了哪条路径记进日志。
 */

import { timingSafeEqual } from 'node:crypto';

import { findActiveHostCredential, type HostCredentialContext } from './hostEnrollmentStore';
import { logFeishuMonitor } from '@/lib/feishu/common/monitor';

export function globalHostToken(): string {
  return (process.env.HOST_API_TOKEN || '').trim();
}

/** 定时安全比较，避免用 === 泄漏长度与逐字符信息 */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function readBearer(request: Request): string {
  const auth = request.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

export type HostAuthResult =
  | { ok: true; integrationId: string; credential: HostCredentialContext | null; source: 'credential' | 'global_token' }
  | { ok: false; status: number; error: string; hint?: string };

export async function authorizeHostRequest(request: Request): Promise<HostAuthResult> {
  const bearer = readBearer(request);
  if (!bearer) {
    return { ok: false, status: 401, error: '缺少宿主凭证。', hint: '请在连接器里配置 TEAMING_HOST_TOKEN。' };
  }

  // 1) 先按「每用户宿主凭证」解析——这是产品化路径
  const credential = await findActiveHostCredential(bearer);
  if (credential) {
    return { ok: true, integrationId: credential.integrationId, credential, source: 'credential' };
  }

  // 2) 回落到全局 token（自用/运维路径）
  const global = globalHostToken();
  if (global && tokenMatches(bearer, global)) {
    const fallbackIntegration = (process.env.HOST_REPORT_INTEGRATION_ID || '').trim();
    if (!fallbackIntegration) {
      return {
        ok: false,
        status: 500,
        error: '服务端未配置 HOST_REPORT_INTEGRATION_ID。',
        hint: '用全局 token 时必须指定报告归属的集成。',
      };
    }
    logFeishuMonitor('warn', 'host_auth_global_token_used', {
      hint: '正在用全局 HOST_API_TOKEN 上传，无法分辨调用方。产品化时应改用接入码兑换的宿主凭证。',
    });
    return { ok: true, integrationId: fallbackIntegration, credential: null, source: 'global_token' };
  }

  return {
    ok: false,
    status: 401,
    error: '宿主凭证无效。',
    // 别写 `npx teaming-mcp setup` —— Skill / MCP-over-HTTP 的用户根本不装 npm，
    // 那句话对他们没有可执行性。给一个所有人都能走的路子：重新要一个接入码。
    hint: '接入码可能已失效或被吊销。重新申请一个即可（只需填姓名）：'
      + ' https://my.feishu.cn/share/base/form/shrcnlPdC7aoXczqLl3XkxGvWhc',
  };
}
