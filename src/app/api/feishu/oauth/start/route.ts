import { NextResponse } from 'next/server';
import { getFeishuUserOauthRedirectUri } from '@/lib/feishu/config';
import {
  createOauthState,
  getUserFeishuIntegrationDetail,
} from '@/lib/feishu/integrationStore';
import { getDefaultFeishuOauthScope } from '@/lib/platform/env';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getAuthenticatedUser } from '@/lib/supabase/server';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const integrationId = url.searchParams.get('integrationId');
    const redirectTo = url.searchParams.get('redirectTo');
    const redirectUri = getFeishuUserOauthRedirectUri();

    logRuntimeMonitor('info', 'oauth_start', 'oauth_start_requested', {
      hasIntegrationId: Boolean(integrationId),
      redirectTo: redirectTo || null,
      redirectUri,
    });

    if (!integrationId) {
      logRuntimeMonitor('warn', 'oauth_start', 'oauth_start_rejected_missing_integration', {
        redirectTo: redirectTo || null,
        redirectUri,
      });
      return NextResponse.json(
        {
          success: false,
          error: '缺少 integrationId，请从飞书配置页为指定集成发起 OAuth 授权。',
        },
        { status: 400 }
      );
    }

    const user = await getAuthenticatedUser();
    if (!user) {
      logRuntimeMonitor('warn', 'oauth_start', 'oauth_start_rejected_unauthenticated', {
        integrationId,
        redirectTo: redirectTo || null,
      });
      return NextResponse.json(
        {
          success: false,
          error: '请先登录后再发起飞书 OAuth 授权。',
        },
        { status: 401 }
      );
    }

    const integration = await getUserFeishuIntegrationDetail(user.id, integrationId);
    if (!integration) {
      logRuntimeMonitor('warn', 'oauth_start', 'oauth_start_rejected_integration_missing', {
        userId: user.id,
        integrationId,
      });
      return NextResponse.json(
        {
          success: false,
          error: '未找到对应的飞书集成配置。',
        },
        { status: 404 }
      );
    }

    const appId = integration.appId;
    const scope = integration.oauthScope || getDefaultFeishuOauthScope();
    const state = await createOauthState({
      userId: user.id,
      integrationId,
      redirectTo,
    });

    logRuntimeMonitor('info', 'oauth_start', 'oauth_start_state_created', {
      userId: user.id,
      integrationId,
      redirectTo: redirectTo || null,
      redirectUri,
      scopeCount: scope.split(/\s+/).filter(Boolean).length,
    });

    const authorizeUrl = new URL('https://open.feishu.cn/open-apis/authen/v1/authorize');
    authorizeUrl.searchParams.set('app_id', appId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', scope);
    authorizeUrl.searchParams.set('state', state);

    logRuntimeMonitor('info', 'oauth_start', 'oauth_start_redirecting', {
      hasIntegrationId: Boolean(integrationId),
      integrationId: integrationId || null,
      redirectUri,
      scopeCount: scope.split(/\s+/).filter(Boolean).length,
    });

    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    logRuntimeMonitor('error', 'oauth_start', 'oauth_start_failed', {
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '无法生成飞书 OAuth 授权链接',
      },
      { status: 500 }
    );
  }
}
