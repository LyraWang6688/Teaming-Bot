import * as lark from '@larksuiteoapi/node-sdk';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { createSession } from '@/lib/auth/session';
import { findOrCreateUserByFeishu } from '@/lib/auth/userStore';
import {
  getDefaultFeishuOauthScope,
  getFeishuAppId,
  getFeishuAppSecret,
  getProjectPublicUrl,
} from '@/lib/platform/env';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

const LOGIN_STATE_COOKIE = 'teaming_login_state';
const LOGIN_NEXT_COOKIE = 'teaming_login_next';
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;

function getLoginCallbackUrl() {
  return `${getProjectPublicUrl()}/api/auth/callback`;
}

function getSafeNextPath(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return '/feishu-config';
  }
  return value;
}

function redirectToLoginError(reason: string, nextPath?: string) {
  const target = new URL('/login', getProjectPublicUrl());
  target.searchParams.set('error', reason);
  if (nextPath) {
    target.searchParams.set('next', nextPath);
  }
  return NextResponse.redirect(target);
}

function clearLoginCookies(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  cookieStore.delete(LOGIN_STATE_COOKIE);
  cookieStore.delete(LOGIN_NEXT_COOKIE);
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const oauthError = request.nextUrl.searchParams.get('error');
  const cookieStore = await cookies();
  const expectedState = cookieStore.get(LOGIN_STATE_COOKIE)?.value;
  const nextPath = getSafeNextPath(cookieStore.get(LOGIN_NEXT_COOKIE)?.value);

  if (!code && !oauthError) {
    clearLoginCookies(cookieStore);
    return redirectToLoginError('invalid_callback', nextPath);
  }

  if (!state || !expectedState || state !== expectedState) {
    clearLoginCookies(cookieStore);
    return redirectToLoginError('invalid_state', nextPath);
  }

  if (oauthError || !code) {
    clearLoginCookies(cookieStore);
    return redirectToLoginError('auth_failed', nextPath);
  }

  try {
    const client = new lark.Client({
      appId: getFeishuAppId(),
      appSecret: getFeishuAppSecret(),
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
      source: 'teaming-meeting-analysis-login',
    });

    const token = await client.accessToken.retrieveByAuthorizationCode({
      code,
      redirectUri: getLoginCallbackUrl(),
    });

    if (!token.accessToken) {
      throw new Error('飞书未返回 Access Token。');
    }

    const userInfoResponse = await client.authen.v1.userInfo.get(
      {},
      lark.withUserAccessToken(token.accessToken)
    );

    if (typeof userInfoResponse.code === 'number' && userInfoResponse.code !== 0) {
      throw new Error(userInfoResponse.msg || '读取飞书登录用户信息失败。');
    }

    const feishuUser = userInfoResponse.data;
    const openId = feishuUser?.open_id;
    if (!openId) {
      throw new Error('飞书登录成功，但未返回 open_id。');
    }

    const result = await findOrCreateUserByFeishu({
      openId,
      name: feishuUser?.name || openId,
      email: feishuUser?.email || feishuUser?.enterprise_email,
      avatarUrl: feishuUser?.avatar_url,
      unionId: feishuUser?.union_id,
    });
    await createSession(result.user.id);
    clearLoginCookies(cookieStore);

    logRuntimeMonitor('info', 'auth_api', 'login_callback_succeeded', {
      userId: result.user.id,
      isNewUser: result.isNew,
      authorizedOpenId: openId,
      scope: token.scope || getDefaultFeishuOauthScope(),
      tokenExpiresIn: token.expiresIn || DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      durationMs: Date.now() - startedAt,
      nextPath,
    });

    return NextResponse.redirect(new URL(nextPath, getProjectPublicUrl()));
  } catch (error) {
    clearLoginCookies(cookieStore);
    logRuntimeMonitor('error', 'auth_api', 'login_callback_failed', {
      durationMs: Date.now() - startedAt,
      nextPath,
      ...toRuntimeErrorContext(error),
    });
    return redirectToLoginError('auth_failed', nextPath);
  }
}
