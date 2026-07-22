import type { FeishuAuthorizationContext, FeishuIntegrationContext } from './integrationStore';
import {
  getLatestFeishuAuthorizationContext,
  markFeishuAuthorizationStatus,
  upsertFeishuAuthorization,
  writeAuditLog,
} from './integrationStore';
import { createFeishuSdkClient } from './sdkClient';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const refreshLocks = new Map<string, Promise<FeishuAuthorizationContext>>();

export class FeishuAuthorizationError extends Error {
  constructor(
    public readonly code: 'not_authorized' | 'refresh_token_missing' | 'refresh_token_expired' | 'refresh_failed',
    message: string
  ) {
    super(message);
    this.name = 'FeishuAuthorizationError';
  }
}

function isAccessTokenUsable(authorization: FeishuAuthorizationContext): boolean {
  return authorization.accessTokenExpiresAt.getTime() - Date.now() > ACCESS_TOKEN_REFRESH_WINDOW_MS;
}

async function refreshAuthorization(
  integration: FeishuIntegrationContext,
  authorization: FeishuAuthorizationContext
): Promise<FeishuAuthorizationContext> {
  if (!authorization.refreshToken) {
    await markFeishuAuthorizationStatus(integration.id, 'reauthorization_required');
    throw new FeishuAuthorizationError(
      'refresh_token_missing',
      '飞书授权缺少 Refresh Token，请重新授权后再继续。'
    );
  }

  if (
    authorization.refreshTokenExpiresAt &&
    authorization.refreshTokenExpiresAt.getTime() <= Date.now()
  ) {
    await markFeishuAuthorizationStatus(integration.id, 'reauthorization_required');
    throw new FeishuAuthorizationError(
      'refresh_token_expired',
      '飞书持续授权已过期，请重新授权后再继续。'
    );
  }

  const startedAt = Date.now();
  try {
    const client = createFeishuSdkClient(integration);
    const response = await client.accessToken.refresh({
      refreshToken: authorization.refreshToken,
      scope: integration.oauthScope,
    });
    const now = Date.now();
    const nextRefreshToken = response.refreshToken || authorization.refreshToken;
    const nextRefreshExpiresAt = response.refreshTokenExpiresIn
      ? new Date(now + response.refreshTokenExpiresIn * 1000)
      : authorization.refreshTokenExpiresAt;

    await upsertFeishuAuthorization({
      integrationId: integration.id,
      status: 'authorized',
      authorizedOpenId: authorization.authorizedOpenId,
      authorizedUserName: authorization.authorizedUserName,
      accessToken: response.accessToken,
      refreshToken: nextRefreshToken,
      accessTokenExpiresAt: new Date(
        now + (response.expiresIn || DEFAULT_ACCESS_TOKEN_TTL_SECONDS) * 1000
      ),
      refreshTokenExpiresAt: nextRefreshExpiresAt,
      scope: response.scope || authorization.scope || integration.oauthScope,
    });

    await writeAuditLog({
      userId: integration.userId,
      integrationId: integration.id,
      action: 'oauth.token.refreshed',
      result: 'success',
      summary: '刷新飞书用户访问令牌',
      metadata: {
        durationMs: Date.now() - startedAt,
        refreshTokenRotated: response.refreshToken
          ? response.refreshToken !== authorization.refreshToken
          : false,
      },
    });

    const refreshed = await getLatestFeishuAuthorizationContext(integration.id);
    if (!refreshed) {
      throw new Error('刷新成功后未找到授权记录。');
    }
    return refreshed;
  } catch (error) {
    await markFeishuAuthorizationStatus(integration.id, 'reauthorization_required');
    await writeAuditLog({
      userId: integration.userId,
      integrationId: integration.id,
      action: 'oauth.token.refreshed',
      result: 'failed',
      summary: '刷新飞书用户访问令牌失败',
      metadata: {
        durationMs: Date.now() - startedAt,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
    });
    logRuntimeMonitor('error', 'feishu_token_service', 'token_refresh_failed', {
      userId: integration.userId,
      integrationId: integration.id,
      durationMs: Date.now() - startedAt,
      ...toRuntimeErrorContext(error),
    });
    if (error instanceof FeishuAuthorizationError) {
      throw error;
    }
    throw new FeishuAuthorizationError(
      'refresh_failed',
      '飞书授权已失效且自动续期失败，请重新授权后再继续。'
    );
  }
}

export async function getValidIntegrationUserAuthorization(
  integration: FeishuIntegrationContext
): Promise<FeishuAuthorizationContext> {
  const authorization = await getLatestFeishuAuthorizationContext(integration.id);
  if (!authorization || authorization.status !== 'authorized') {
    throw new FeishuAuthorizationError(
      'not_authorized',
      '当前飞书集成尚未完成有效的用户授权。'
    );
  }

  if (!authorization.refreshToken) {
    await markFeishuAuthorizationStatus(integration.id, 'reauthorization_required');
    throw new FeishuAuthorizationError(
      'refresh_token_missing',
      '当前飞书授权缺少 Refresh Token，请重新完成一次用户授权。'
    );
  }

  if (isAccessTokenUsable(authorization)) {
    return authorization;
  }

  const existingRefresh = refreshLocks.get(integration.id);
  if (existingRefresh) {
    return existingRefresh;
  }

  const refreshPromise = refreshAuthorization(integration, authorization).finally(() => {
    refreshLocks.delete(integration.id);
  });
  refreshLocks.set(integration.id, refreshPromise);
  return refreshPromise;
}
