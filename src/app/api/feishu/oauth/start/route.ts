import { NextResponse } from 'next/server';
import {
  getFeishuAppCredentials,
  getFeishuUserOauthRedirectUri,
} from '@/lib/feishu/config';
import {
  createOauthState,
  getUserFeishuIntegrationDetail,
} from '@/lib/feishu/integrationStore';
import { getDefaultFeishuOauthScope } from '@/lib/platform/env';
import { getAuthenticatedUser } from '@/lib/supabase/server';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const integrationId = url.searchParams.get('integrationId');
    const redirectTo = url.searchParams.get('redirectTo');
    const redirectUri = getFeishuUserOauthRedirectUri();

    let appId: string;
    let scope: string;
    let state: string;

    if (integrationId) {
      const user = await getAuthenticatedUser();
      if (!user) {
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
        return NextResponse.json(
          {
            success: false,
            error: '未找到对应的飞书集成配置。',
          },
          { status: 404 }
        );
      }

      appId = integration.appId;
      scope = integration.oauthScope || getDefaultFeishuOauthScope();
      state = await createOauthState({
        userId: user.id,
        integrationId,
        redirectTo,
      });
    } else {
      ({ appId } = getFeishuAppCredentials());
      scope = getDefaultFeishuOauthScope();
      state = `feishu-oauth-${Date.now()}`;
    }

    const authorizeUrl = new URL('https://open.feishu.cn/open-apis/authen/v1/authorize');
    authorizeUrl.searchParams.set('app_id', appId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', scope);
    authorizeUrl.searchParams.set('state', state);

    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '无法生成飞书 OAuth 授权链接',
      },
      { status: 500 }
    );
  }
}
