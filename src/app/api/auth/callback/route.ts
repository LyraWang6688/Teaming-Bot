import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { exchangeFeishuCode } from '@/lib/auth/feishuOAuth';
import { findOrCreateUserByFeishu } from '@/lib/auth/userStore';
import { createSession } from '@/lib/auth/session';

const STATE_COOKIE_NAME = 'feishu_oauth_state';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    if (!code || !state) {
      return NextResponse.redirect('/login?error=invalid_callback');
    }

    const cookieStore = await cookies();
    const savedState = cookieStore.get(STATE_COOKIE_NAME)?.value;

    if (!savedState || savedState !== state) {
      return NextResponse.redirect('/login?error=invalid_state');
    }

    cookieStore.delete(STATE_COOKIE_NAME);

    const feishuUser = await exchangeFeishuCode(code);

    const { user } = await findOrCreateUserByFeishu({
      openId: feishuUser.openId,
      unionId: feishuUser.unionId,
      name: feishuUser.name,
      email: feishuUser.email,
      avatarUrl: feishuUser.avatarUrl,
    });

    await createSession(user.id);

    return NextResponse.redirect('/feishu-config');
  } catch (error) {
    console.error('[auth:callback] 飞书授权回调失败', error);
    return NextResponse.redirect('/login?error=auth_failed');
  }
}
