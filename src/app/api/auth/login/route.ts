import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { generateOauthState, getFeishuOAuthUrl } from '@/lib/auth/feishuOAuth';

const STATE_COOKIE_NAME = 'feishu_oauth_state';
const STATE_MAX_AGE = 10 * 60;

export async function GET() {
  try {
    const state = generateOauthState();
    const authUrl = getFeishuOAuthUrl(state);

    const cookieStore = await cookies();
    cookieStore.set(STATE_COOKIE_NAME, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: STATE_MAX_AGE,
    });

    return NextResponse.redirect(authUrl);
  } catch (error) {
    console.error('[auth:login] 生成飞书授权链接失败', error);
    return NextResponse.json(
      { success: false, error: '生成授权链接失败' },
      { status: 500 }
    );
  }
}

export const OAUTH_STATE_COOKIE = STATE_COOKIE_NAME;
