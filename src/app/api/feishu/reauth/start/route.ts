/**
 * 授权失效提醒链接的免会话入口。
 *
 * 链接来自授权失效提醒消息（签名令牌，7 天有效）。不校验浏览器会话——
 * 目标用户的 30 天会话可能已过期；本人身份由后续飞书 OAuth 回调中的
 * open_id 与集成已存 authorizedOpenId 比对来保证。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getFeishuOauthCallbackUrl } from '@/lib/feishu/integration/integrationConfig';
import { FEISHU_REQUIRED_USER_SCOPE } from '@/lib/feishu/integration/integrationConstants';
import {
  createOauthState,
  getFeishuIntegrationContextById,
  writeAuditLog,
} from '@/lib/feishu/integration/integrationStore';
import { verifyReauthToken } from '@/lib/feishu/integration/reauthToken';
import { REAUTH_STATE_MARKER } from '@/lib/feishu/integration/reauthMarker';
import { getProjectPublicUrl } from '@/lib/platform/env';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getRequestTraceContext } from '@/lib/platform/requestTrace';

function failureRedirect(reason: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/feishu-config?oauth=failed&reason=${encodeURIComponent(reason)}`, getProjectPublicUrl())
  );
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const traceContext = getRequestTraceContext(request);
  const verified = verifyReauthToken(request.nextUrl.searchParams.get('t') || '');
  if (!verified) {
    return failureRedirect('reauth_link_invalid_or_expired');
  }

  try {
    const integration = await getFeishuIntegrationContextById(verified.integrationId);
    if (!integration) {
      return failureRedirect('reauth_integration_missing');
    }

    const state = await createOauthState({
      userId: integration.userId,
      integrationId: integration.id,
      redirectTo: `/feishu-config?oauth=success&${REAUTH_STATE_MARKER}`,
      expiresInMinutes: 30,
    });
    const authorizationUrl = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    authorizationUrl.searchParams.set('client_id', integration.appId);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('redirect_uri', getFeishuOauthCallbackUrl());
    authorizationUrl.searchParams.set('scope', FEISHU_REQUIRED_USER_SCOPE);
    authorizationUrl.searchParams.set('state', state);

    await writeAuditLog({
      userId: integration.userId,
      integrationId: integration.id,
      action: 'oauth.reauth.started',
      result: 'pending',
      summary: '通过授权失效提醒链接发起重新授权',
      metadata: {},
    });
    logRuntimeMonitor('info', 'feishu_sdk_auth', 'reauth_start_completed', {
      ...traceContext,
      integrationId: integration.id,
      userId: integration.userId,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.redirect(authorizationUrl);
  } catch (error) {
    logRuntimeMonitor('error', 'feishu_sdk_auth', 'reauth_start_failed', {
      ...traceContext,
      integrationId: verified.integrationId,
      durationMs: Date.now() - startedAt,
      ...toRuntimeErrorContext(error),
    });
    return failureRedirect('reauth_start_failed');
  }
}
