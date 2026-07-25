import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { createOpaqueToken } from '@/lib/security/crypto';
import {
  getDefaultFeishuOauthScope,
  getFeishuAppId,
  getProjectPublicUrl,
} from '@/lib/platform/env';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

const LOGIN_STATE_COOKIE = 'teaming_login_state';
const LOGIN_NEXT_COOKIE = 'teaming_login_next';
const LOGIN_COOKIE_MAX_AGE_SECONDS = 10 * 60;

function getLoginCallbackUrl() {
  return `${getProjectPublicUrl()}/api/auth/callback`;
}

function getSafeNextPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return '/feishu-config';
  }
  return value;
}

export async function GET(request: NextRequest) {
  const nextPath = getSafeNextPath(request.nextUrl.searchParams.get('next'));
  const startedAt = Date.now();

  try {
    const state = createOpaqueToken(24);
    const cookieStore = await cookies();
    cookieStore.set(LOGIN_STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: LOGIN_COOKIE_MAX_AGE_SECONDS,
    });
    cookieStore.set(LOGIN_NEXT_COOKIE, nextPath, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: LOGIN_COOKIE_MAX_AGE_SECONDS,
    });

    const authorizationUrl = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    authorizationUrl.searchParams.set('client_id', getFeishuAppId());
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('redirect_uri', getLoginCallbackUrl());
    authorizationUrl.searchParams.set('scope', getDefaultFeishuOauthScope());
    authorizationUrl.searchParams.set('state', state);

    logRuntimeMonitor('info', 'auth_api', 'login_redirect_started', {
      nextPath,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.redirect(authorizationUrl);
  } catch (error) {
    logRuntimeMonitor('error', 'auth_api', 'login_redirect_failed', {
      nextPath,
      durationMs: Date.now() - startedAt,
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.redirect(
      new URL('/login?error=auth_failed', getProjectPublicUrl())
    );
  }
}
