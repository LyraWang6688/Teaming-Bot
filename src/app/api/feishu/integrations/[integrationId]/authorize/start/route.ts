import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import {
  createOauthState,
  getFeishuIntegrationCheckStatus,
  getUserFeishuIntegrationContext,
  writeAuditLog,
} from '@/lib/feishu/integration/integrationStore';
import {
  getFeishuOauthCallbackUrl,
  getFeishuOauthSuccessRedirect,
} from '@/lib/feishu/integration/integrationConfig';
import { FEISHU_REQUIRED_USER_SCOPE } from '@/lib/feishu/integration/integrationConstants';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getRequestTraceContext } from '@/lib/platform/requestTrace';

type RouteContext = { params: Promise<{ integrationId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const startedAt = Date.now();
  const traceContext = getRequestTraceContext(request);
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ success: false, error: '请先登录' }, { status: 401 });
  }

  const { integrationId } = await context.params;
  try {
    const integration = await getUserFeishuIntegrationContext(user.id, integrationId);
    if (!integration) {
      return NextResponse.json({ success: false, error: '未找到集成配置' }, { status: 404 });
    }
    const checks = await getFeishuIntegrationCheckStatus(integrationId);
    if (checks?.appCredentialStatus !== 'success') {
      return NextResponse.json(
        { success: false, error: '飞书应用尚未创建并通过校验，请先完成第一步。' },
        { status: 409 }
      );
    }

    const state = await createOauthState({
      userId: user.id,
      integrationId,
      redirectTo: getFeishuOauthSuccessRedirect(integrationId),
      expiresInMinutes: 10,
    });
    const authorizationUrl = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    authorizationUrl.searchParams.set('client_id', integration.appId);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('redirect_uri', getFeishuOauthCallbackUrl());
    authorizationUrl.searchParams.set('scope', FEISHU_REQUIRED_USER_SCOPE);
    authorizationUrl.searchParams.set('state', state);

    await writeAuditLog({
      userId: user.id,
      integrationId,
      action: 'oauth.authorization.started',
      result: 'pending',
      summary: '发起飞书用户 OAuth 授权',
      metadata: { scope: FEISHU_REQUIRED_USER_SCOPE },
    });
    logRuntimeMonitor('info', 'feishu_sdk_auth', 'authorize_start_completed', {
      ...traceContext,
      stage: 'authorize_start',
      integrationId,
      userId: user.id,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      success: true,
      data: {
        authorizationUrl: authorizationUrl.toString(),
        expiresIn: 600,
      },
    });
  } catch (error) {
    logRuntimeMonitor('error', 'feishu_sdk_auth', 'authorize_start_failed', {
      ...traceContext,
      stage: 'authorize_start',
      integrationId,
      userId: user.id,
      durationMs: Date.now() - startedAt,
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '发起授权失败' },
      { status: 500 }
    );
  }
}
