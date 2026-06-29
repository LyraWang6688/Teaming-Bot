import {
  getLatestFeishuAuthorizationContext,
  type FeishuAuthorizationContext,
  type FeishuIntegrationContext,
  upsertFeishuAuthorization,
} from './integrationStore';
import { FeishuOpenApiError, type FeishuApiResponse } from '../common/openapi';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { createLarkAppClient, createLarkUserClient } from '../common/larkSdkClient';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

const RETRYABLE_USER_AUTH_ERROR_CODES = new Set([2094011, 2094012]);
const RETRYABLE_USER_AUTH_MESSAGE_PATTERNS = [
  'invalid access token',
  'invalid user access token',
  'access token expired',
  'expired access token',
  'token attached',
];

function containsRetryableUserAuthMessage(value?: string): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toLowerCase();
  return RETRYABLE_USER_AUTH_MESSAGE_PATTERNS.some((pattern) =>
    normalized.includes(pattern)
  );
}

function shouldRetryUserRequest(error: unknown): boolean {
  if (!(error instanceof FeishuOpenApiError)) {
    return false;
  }

  if (error.statusCode === 401 || error.statusCode === 403) {
    return true;
  }

  if (error.code && RETRYABLE_USER_AUTH_ERROR_CODES.has(error.code)) {
    return true;
  }

  return (
    containsRetryableUserAuthMessage(error.message) ||
    containsRetryableUserAuthMessage(error.body)
  );
}

export async function getValidIntegrationUserAuthorization(
  integration: FeishuIntegrationContext
): Promise<FeishuAuthorizationContext> {
  const authorization = await getLatestFeishuAuthorizationContext(integration.id);
  if (!authorization) {
    throw new Error('当前集成尚未完成 OAuth 授权。');
  }

  if (authorization.accessTokenExpiresAt.getTime() > Date.now() + 60_000) {
    return authorization;
  }

  try {
    return await refreshIntegrationUserAccessToken(integration, authorization);
  } catch (error) {
    logRuntimeMonitor('error', 'integration_openapi', 'integration_user_token_refresh_failed', {
      integrationId: integration.id,
      ...toRuntimeErrorContext(error),
    });
    throw error;
  }
}

async function refreshIntegrationUserAccessToken(
  integration: FeishuIntegrationContext,
  authorization: FeishuAuthorizationContext
): Promise<FeishuAuthorizationContext> {
  if (!authorization.refreshToken) {
    throw new Error('当前集成缺少 refresh token，无法刷新 user_access_token。');
  }

  const client = await createLarkAppClient({
    appId: integration.appId,
    appSecret: integration.secrets.appSecret,
  });

  const response = await client.request({
    url: '/authen/v2/oauth/token',
    method: 'POST',
    data: {
      grant_type: 'refresh_token',
      client_id: integration.appId,
      client_secret: integration.secrets.appSecret,
      refresh_token: authorization.refreshToken,
    },
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });

  const payload = (await response.json().catch(() => ({}))) as {
    code: number;
    msg?: string;
    error?: string;
    error_description?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
  };

  if (!payload.access_token) {
    throw new FeishuOpenApiError({
      message:
        payload.error_description ||
        payload.msg ||
        payload.error ||
        '刷新 user_access_token 失败',
      method: 'POST',
      path: '/authen/v2/oauth/token',
      code: payload.code,
    });
  }

  const accessTokenExpiresAt = new Date(
    Date.now() + Math.max(payload.expires_in || 7200, 60) * 1000
  );
  const refreshTokenExpiresAt = payload.refresh_token_expires_in
    ? new Date(Date.now() + Math.max(payload.refresh_token_expires_in, 60) * 1000)
    : null;
  const nextRefreshToken = payload.refresh_token || authorization.refreshToken;

  await upsertFeishuAuthorization({
    integrationId: integration.id,
    authorizedOpenId: authorization.authorizedOpenId,
    authorizedUserName: authorization.authorizedUserName,
    accessToken: payload.access_token,
    refreshToken: nextRefreshToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    scope: authorization.scope,
    status: 'authorized',
  });

  logRuntimeMonitor('info', 'integration_openapi', 'integration_user_token_refreshed', {
    integrationId: integration.id,
    accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
    hasRefreshToken: Boolean(nextRefreshToken),
  });

  return {
    ...authorization,
    status: 'authorized',
    accessToken: payload.access_token,
    refreshToken: nextRefreshToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    updatedAt: new Date().toISOString(),
  };
}

export async function callFeishuIntegrationUserOpenApi<T = unknown>(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>
): Promise<T> {
  const authorization = await getValidIntegrationUserAuthorization(integration);

  try {
    const client = await createLarkUserClient({
      appId: integration.appId,
      appSecret: integration.secrets.appSecret,
      userAccessToken: authorization.accessToken,
    });

    const response = await client.request({
      url: path,
      method,
      data: method === 'GET' || method === 'DELETE' ? undefined : data,
      headers: {
        Authorization: `Bearer ${authorization.accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
    });

    const result = (await response.json().catch(() => ({}))) as FeishuApiResponse<T>;
    if (result.code !== 0) {
      throw new FeishuOpenApiError({
        message: result.msg || `飞书 SDK 调用失败：${method} ${path}`,
        method,
        path,
        code: result.code,
      });
    }

    return result.data as T;
  } catch (error) {
    if (!shouldRetryUserRequest(error)) {
      throw error;
    }

    logRuntimeMonitor('warn', 'integration_openapi', 'integration_user_request_retry_after_auth_error', {
      integrationId: integration.id,
      method,
      path,
      ...toRuntimeErrorContext(error),
    });

    const refreshedAuthorization = await refreshIntegrationUserAccessToken(integration, authorization);

    const client = await createLarkUserClient({
      appId: integration.appId,
      appSecret: integration.secrets.appSecret,
      userAccessToken: refreshedAuthorization.accessToken,
    });

    const response = await client.request({
      url: path,
      method,
      data: method === 'GET' || method === 'DELETE' ? undefined : data,
      headers: {
        Authorization: `Bearer ${refreshedAuthorization.accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
    });

    const result = (await response.json().catch(() => ({}))) as FeishuApiResponse<T>;
    if (result.code !== 0) {
      throw new FeishuOpenApiError({
        message: result.msg || `飞书 SDK 调用失败：${method} ${path}`,
        method,
        path,
        code: result.code,
      });
    }

    return result.data as T;
  }
}

export async function callFeishuIntegrationUserOpenApiText(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>
): Promise<string> {
  const authorization = await getValidIntegrationUserAuthorization(integration);

  try {
    const client = await createLarkUserClient({
      appId: integration.appId,
      appSecret: integration.secrets.appSecret,
      userAccessToken: authorization.accessToken,
    });

    const response = await client.request({
      url: path,
      method,
      data: method === 'GET' || method === 'DELETE' ? undefined : data,
      headers: {
        Authorization: `Bearer ${authorization.accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
    });

    return response.text();
  } catch (error) {
    if (!shouldRetryUserRequest(error)) {
      throw error;
    }

    logRuntimeMonitor(
      'warn',
      'integration_openapi',
      'integration_user_text_request_retry_after_auth_error',
      {
        integrationId: integration.id,
        method,
        path,
        ...toRuntimeErrorContext(error),
      }
    );

    const refreshedAuthorization = await refreshIntegrationUserAccessToken(integration, authorization);

    const client = await createLarkUserClient({
      appId: integration.appId,
      appSecret: integration.secrets.appSecret,
      userAccessToken: refreshedAuthorization.accessToken,
    });

    const response = await client.request({
      url: path,
      method,
      data: method === 'GET' || method === 'DELETE' ? undefined : data,
      headers: {
        Authorization: `Bearer ${refreshedAuthorization.accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
    });

    return response.text();
  }
}

export {
  callFeishuIntegrationUserOpenApi as callFeishuIntegrationUserSdk,
  callFeishuIntegrationUserOpenApiText as callFeishuIntegrationUserSdkText,
};
