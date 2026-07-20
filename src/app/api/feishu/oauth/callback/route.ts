import * as lark from '@larksuiteoapi/node-sdk';
import { NextRequest, NextResponse } from 'next/server';
import { findUserByFeishuOpenId, updateUserIdentityFromFeishu } from '@/lib/auth/userStore';
import {
  consumeOauthState,
  getFeishuIntegrationContextById,
  upsertFeishuAuthorization,
  upsertFeishuIntegrationCheckStatus,
  updateUserFeishuIntegration,
  writeAuditLog,
} from '@/lib/feishu/integration/integrationStore';
import { createFeishuSdkClient } from '@/lib/feishu/integration/sdkClient';
import { getFeishuOauthCallbackUrl } from '@/lib/feishu/integration/integrationConfig';
import { getProjectPublicUrl } from '@/lib/platform/env';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;

function redirectToConfig(path: string): NextResponse {
  const safePath = path.startsWith('/feishu-config') ? path : '/feishu-config';
  return NextResponse.redirect(new URL(safePath, getProjectPublicUrl()));
}

function failureRedirect(reason: string): NextResponse {
  return redirectToConfig(`/feishu-config?oauth=failed&reason=${encodeURIComponent(reason)}`);
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const code = request.nextUrl.searchParams.get('code');
  const rawState = request.nextUrl.searchParams.get('state');
  const oauthError = request.nextUrl.searchParams.get('error');

  if (!rawState) {
    return failureRedirect('invalid_state');
  }

  const state = await consumeOauthState(rawState);
  if (!state) {
    return failureRedirect('invalid_or_expired_state');
  }

  if (oauthError || !code) {
    await writeAuditLog({
      userId: state.userId,
      integrationId: state.integrationId,
      action: 'oauth.authorization.completed',
      result: 'denied',
      summary: '用户未完成飞书 OAuth 授权',
      metadata: { reason: oauthError || 'authorization_code_missing' },
    });
    return failureRedirect(oauthError ? 'access_denied' : 'code_missing');
  }

  try {
    const integration = await getFeishuIntegrationContextById(state.integrationId);
    if (!integration || integration.userId !== state.userId) {
      return failureRedirect('integration_not_found');
    }

    const client = createFeishuSdkClient(integration);
    const token = await client.accessToken.retrieveByAuthorizationCode({
      code,
      redirectUri: getFeishuOauthCallbackUrl(),
    });
    if (!token.accessToken || !token.refreshToken) {
      throw new Error('飞书未返回可持久化的 Access Token 和 Refresh Token。');
    }

    const userInfoResponse = await client.authen.v1.userInfo.get(
      {},
      lark.withUserAccessToken(token.accessToken)
    );
    if (typeof userInfoResponse.code === 'number' && userInfoResponse.code !== 0) {
      throw new Error(userInfoResponse.msg || '读取飞书授权用户身份失败。');
    }
    const feishuUser = userInfoResponse.data;
    const openId = feishuUser?.open_id;
    if (!openId) {
      throw new Error('飞书授权成功，但未返回授权用户 open_id。');
    }

    const existingBoundUser = await findUserByFeishuOpenId(openId);
    if (existingBoundUser && existingBoundUser.id !== state.userId) {
      throw new Error('该飞书账号已绑定到其他本地用户，请退出当前会话后重新操作。');
    }

    await updateUserIdentityFromFeishu(state.userId, {
      openId,
      name: feishuUser?.name || openId,
      email: feishuUser?.email || feishuUser?.enterprise_email,
      avatarUrl: feishuUser?.avatar_url,
      unionId: feishuUser?.union_id,
    });

    const now = Date.now();
    await upsertFeishuAuthorization({
      integrationId: integration.id,
      status: 'authorized',
      authorizedOpenId: openId,
      authorizedUserName: feishuUser?.name || openId,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessTokenExpiresAt: new Date(
        now + (token.expiresIn || DEFAULT_ACCESS_TOKEN_TTL_SECONDS) * 1000
      ),
      refreshTokenExpiresAt: token.refreshTokenExpiresIn
        ? new Date(now + token.refreshTokenExpiresIn * 1000)
        : null,
      scope: token.scope || integration.oauthScope,
    });
    await upsertFeishuIntegrationCheckStatus({
      integrationId: integration.id,
      appCredentialStatus: 'success',
      oauthStatus: 'authorized',
      baseStatus: 'pending',
      permissionStatus: 'pending',
      eventSubscriptionStatus: 'pending',
      lastErrorType: null,
      lastErrorMessage: null,
      details: {
        oauth: {
          ok: true,
          credentialMode: 'database_token_service',
          authorizedOpenId: openId,
        },
      },
    });
    await updateUserFeishuIntegration(state.userId, integration.id, {
      setupStep: 'oauth',
      status: 'draft',
    });
    await writeAuditLog({
      userId: state.userId,
      integrationId: integration.id,
      action: 'oauth.authorization.completed',
      result: 'success',
      summary: '完成飞书 OAuth 授权并加密保存令牌',
      metadata: {
        authorizedOpenId: openId,
        scope: token.scope || integration.oauthScope,
        hasRefreshToken: true,
      },
    });
    logRuntimeMonitor('info', 'feishu_sdk_auth', 'oauth_callback_completed', {
      userId: state.userId,
      integrationId: integration.id,
      authorizedOpenId: openId,
      durationMs: Date.now() - startedAt,
    });

    return redirectToConfig(state.redirectTo || `/feishu-config?oauth=success`);
  } catch (error) {
    await writeAuditLog({
      userId: state.userId,
      integrationId: state.integrationId,
      action: 'oauth.authorization.completed',
      result: 'failed',
      summary: '飞书 OAuth 回调处理失败',
      metadata: { errorType: error instanceof Error ? error.name : 'UnknownError' },
    });
    logRuntimeMonitor('error', 'feishu_sdk_auth', 'oauth_callback_failed', {
      userId: state.userId,
      integrationId: state.integrationId,
      durationMs: Date.now() - startedAt,
      ...toRuntimeErrorContext(error),
    });
    return failureRedirect('token_exchange_failed');
  }
}
