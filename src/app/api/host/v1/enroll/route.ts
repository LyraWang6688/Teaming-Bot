/**
 * 宿主接入：用接入码兑换一个只属于这次安装的宿主凭证。
 *
 * ## 流程
 *
 * ```
 * 运营侧  POST /api/host/v1/enroll 的 code 来源：
 *           psql / 管理脚本生成（见 scripts/createHostEnrollmentCode.mjs）
 *              ↓ 把码发给用户
 * 用户    npx teaming-mcp setup --code XXXX
 *              ↓ MCP 调本接口
 * 本接口  校验码 → 生成 host_token（只返回这一次）→ 记录到 host_credentials
 *              ↓
 * 用户    之后每次上传报告都带这个 token，服务端据此判定归属
 * ```
 *
 * ## 鉴权
 *
 * 本接口**不需要 Bearer**——接入码本身就是凭证。所以：
 * - 码用 8 位、去掉易混淆字符（约 40 bit），够挡暴力枚举；
 * - 有次数上限与有效期，可单独吊销；
 * - 每次兑换都记 `installation_id`，便于分辨是哪台机器。
 *
 * TODO(产品化)：接入码枚举是当前唯一的暴破面，应加按 IP 的失败计数限流。
 */

import { NextRequest, NextResponse } from 'next/server';

import { getFeishuIntegrationContextById } from '@/lib/feishu/integration/integrationStore';
import { logFeishuMonitor, toErrorContext } from '@/lib/feishu/common/monitor';
import { redeemEnrollmentCode } from '@/lib/host/hostEnrollmentStore';

const ROUTE = '/api/host/v1/enroll';

const REASON_TEXT: Record<string, { error: string; hint: string }> = {
  code_not_found: { error: '接入码不存在。', hint: '请核对是否输错（不含 0/O、1/I/L 这些易混字符）。' },
  code_revoked: { error: '接入码已被吊销。', hint: '请向管理员索取新的接入码。' },
  code_expired: { error: '接入码已过期。', hint: '请向管理员索取新的接入码。' },
  code_exhausted: { error: '接入码使用次数已用尽。', hint: '请向管理员索取新的接入码。' },
};

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON。' }, { status: 400 });
  }

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!code) {
    return NextResponse.json({ ok: false, error: '缺少接入码。' }, { status: 400 });
  }

  const installationId = typeof body.installationId === 'string' ? body.installationId.trim() : null;
  const label = typeof body.label === 'string' ? body.label.trim() : null;

  try {
    const result = await redeemEnrollmentCode({ code, installationId, label });
    if (!result.ok) {
      const text = REASON_TEXT[result.reason] ?? { error: '接入码不可用。', hint: '' };
      logFeishuMonitor('warn', 'host_enroll_rejected', { route: ROUTE, reason: result.reason });
      return NextResponse.json(
        { ok: false, error: text.error, hint: text.hint || undefined },
        { status: 400 }
      );
    }

    const integration = await getFeishuIntegrationContextById(result.integrationId);
    if (!integration) {
      // 码有效但集成没了：说明运营侧删了集成，属于配置错误而不是用户输入问题
      logFeishuMonitor('error', 'host_enroll_integration_missing', {
        route: ROUTE,
        integrationId: result.integrationId,
      });
      return NextResponse.json(
        { ok: false, error: '接入码对应的集成已不存在。', hint: '请向管理员索取新的接入码。' },
        { status: 409 }
      );
    }

    logFeishuMonitor('info', 'host_enrolled', {
      route: ROUTE,
      integrationId: integration.id,
      credentialId: result.credentialId,
      installationId,
    });

    // 顺带下发模型配置，让用户"一个码"就能配好——否则他还要手工填 key、端点、模型。
    //
    // 取舍：这会把分析用的模型 key 发到用户机器上。当前阶段（模型费用由我们承担）
    // 这是有意的；将来若改成"分析也走服务端"，这三个字段就该撤掉。
    //
    // 2026-10-14：新增 HOST_ANALYSIS_* 一组，用来**单独指定下发给宿主的模型配置**。
    // 理由：宿主侧（MCP）与服务器侧（常驻流水线）可以用不同的模型，各算各的账。
    // 当前 MCP 默认走 DeepSeek，而服务器自身的分析仍是豆包，两者不能混用同一组变量。
    //
    // 优先级：HOST_ANALYSIS_* > DOUBAO_* / LLM_* / ARK_*
    const analysis = {
      apiKey: (process.env.HOST_ANALYSIS_API_KEY
        || process.env.DOUBAO_API_KEY || process.env.LLM_API_KEY || process.env.ARK_API_KEY || '').trim() || null,
      baseUrl: (process.env.HOST_ANALYSIS_BASE_URL
        || process.env.DOUBAO_BASE_URL || process.env.LLM_BASE_URL || process.env.ARK_BASE_URL || '').trim() || null,
      model: (process.env.HOST_ANALYSIS_MODEL
        || process.env.DOUBAO_MODEL || process.env.ANALYSIS_MODEL || '').trim() || null,
    };

    // token 明文只在这里返回一次，服务端只留 hash
    return NextResponse.json({
      ok: true,
      hostToken: result.token,
      integrationId: integration.id,
      integrationName: integration.name ?? null,
      installationId,
      analysis,
    });
  } catch (error) {
    logFeishuMonitor('error', 'host_enroll_failed', { route: ROUTE, ...toErrorContext(error) });
    return NextResponse.json(
      { ok: false, error: '兑换失败。', hint: '请稍后重试或联系管理员。' },
      { status: 500 }
    );
  }
}
