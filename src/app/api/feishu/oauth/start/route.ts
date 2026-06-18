import { NextResponse } from 'next/server';
import {
  getFeishuAppCredentials,
  getFeishuUserOauthRedirectUri,
  getFeishuUserOauthScope,
} from '@/lib/feishu/config';

export async function GET() {
  try {
    const { appId } = getFeishuAppCredentials();
    const redirectUri = getFeishuUserOauthRedirectUri();
    const scope = getFeishuUserOauthScope();
    const state = `feishu-oauth-${Date.now()}`;

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
