import {
  getLatestFeishuAuthorizationContext,
  type FeishuAuthorizationContext,
  type FeishuIntegrationContext,
  upsertFeishuAuthorization,
} from './integrationStore';
import { FeishuOpenApiError, type FeishuApiResponse } from './openapi';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

type TenantAccessTokenResponse = {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
};

type UserAccessTokenRefreshResponse = {
  code: number;
  msg?: string;
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
};

const FEISHU_OPENAPI_BASE_URL = 'https://open.feishu.cn/open-apis';
const RETRYABLE_USER_AUTH_ERROR_CODES = new Set([2094011, 2094012]);
const RETRYABLE_USER_AUTH_MESSAGE_PATTERNS = [
  'invalid access token',
  'invalid user access token',
  'access token expired',
  'expired access token',
  'token attached',
];

function buildFeishuOpenApiUrl(path: string): string {
  return `${FEISHU_OPENAPI_BASE_URL}${path}`;
}

async function callFeishuOpenApiWithToken<T = unknown>(
  accessToken: string,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(buildFeishuOpenApiUrl(path), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(data || {}),
  });

  const payload = (await response.json().catch(() => ({}))) as FeishuApiResponse<T>;
  if (!response.ok || payload.code !== 0) {
    throw new FeishuOpenApiError({
      message: payload.msg || `飞书 OpenAPI 调用失败：${method} ${path} HTTP ${response.status}`,
      method,
      path,
      statusCode: response.status,
      code: payload.code,
    });
  }

  return payload.data as T;
}

async function callFeishuOpenApiTextWithToken(
  accessToken: string,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>
): Promise<string> {
  const response = await fetch(buildFeishuOpenApiUrl(path), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(data || {}),
  });

  const text = await response.text();
  if (!response.ok) {
    let errorCode: number | undefined;
    let errorMessage = text || `飞书 OpenAPI 调用失败：${method} ${path} HTTP ${response.status}`;

    try {
      const payload = JSON.parse(text) as FeishuApiResponse;
      errorCode = payload.code;
      errorMessage = payload.msg || errorMessage;
    } catch {
      // 文本接口失败时直接透传原始返回。
    }

    throw new FeishuOpenApiError({
      message: errorMessage,
      method,
      path,
      statusCode: response.status,
      code: errorCode,
      body: text,
    });
  }

  return text;
}

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

export async function getTenantAccessTokenForIntegration(
  integration: FeishuIntegrationContext
): Promise<string> {
  const response = await fetch(`${FEISHU_OPENAPI_BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      app_id: integration.appId,
      app_secret: integration.secrets.appSecret,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as TenantAccessTokenResponse;
  if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
    throw new FeishuOpenApiError({
      message: payload.msg || `获取 tenant_access_token 失败：HTTP ${response.status}`,
      method: 'POST',
      path: '/auth/v3/tenant_access_token/internal',
      statusCode: response.status,
      code: payload.code,
    });
  }

  return payload.tenant_access_token;
}

async function refreshIntegrationUserAccessToken(
  integration: FeishuIntegrationContext,
  authorization: FeishuAuthorizationContext
): Promise<FeishuAuthorizationContext> {
  if (!authorization.refreshToken) {
    throw new Error('当前集成缺少 refresh token，无法刷新 user_access_token。');
  }

  const path = '/authen/v2/oauth/token';
  const response = await fetch(buildFeishuOpenApiUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: integration.appId,
      client_secret: integration.secrets.appSecret,
      refresh_token: authorization.refreshToken,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as UserAccessTokenRefreshResponse;
  if (!response.ok || payload.code !== 0 || !payload.access_token) {
    throw new FeishuOpenApiError({
      message:
        payload.error_description ||
        payload.msg ||
        payload.error ||
        `刷新 user_access_token 失败：HTTP ${response.status}`,
      method: 'POST',
      path,
      statusCode: response.status,
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

export async function callFeishuIntegrationTenantOpenApi<T = unknown>(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>
): Promise<T> {
  const token = await getTenantAccessTokenForIntegration(integration);
  return callFeishuOpenApiWithToken<T>(token, method, path, data);
}

export async function callFeishuIntegrationUserOpenApi<T = unknown>(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>
): Promise<T> {
  const authorization = await getValidIntegrationUserAuthorization(integration);

  try {
    return await callFeishuOpenApiWithToken<T>(authorization.accessToken, method, path, data);
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
    return callFeishuOpenApiWithToken<T>(
      refreshedAuthorization.accessToken,
      method,
      path,
      data
    );
  }
}

export async function callFeishuIntegrationTenantOpenApiText(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>
): Promise<string> {
  const token = await getTenantAccessTokenForIntegration(integration);
  return callFeishuOpenApiTextWithToken(token, method, path, data);
}

export async function callFeishuIntegrationUserOpenApiText(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>
): Promise<string> {
  const authorization = await getValidIntegrationUserAuthorization(integration);

  try {
    return await callFeishuOpenApiTextWithToken(authorization.accessToken, method, path, data);
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
    return callFeishuOpenApiTextWithToken(
      refreshedAuthorization.accessToken,
      method,
      path,
      data
    );
  }
}

type PreferredAccessTokenOptions = {
  fallbackToTenant?: boolean;
};

export async function callFeishuIntegrationOpenApiPreferUser<T = unknown>(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>,
  options: PreferredAccessTokenOptions = {}
): Promise<T> {
  const { fallbackToTenant = true } = options;

  try {
    return await callFeishuIntegrationUserOpenApi<T>(integration, method, path, data);
  } catch (error) {
    if (!fallbackToTenant) {
      throw error;
    }

    logRuntimeMonitor('warn', 'integration_openapi', 'integration_preferred_user_request_fallback_to_tenant', {
      integrationId: integration.id,
      method,
      path,
      ...toRuntimeErrorContext(error),
    });
    return callFeishuIntegrationTenantOpenApi<T>(integration, method, path, data);
  }
}

export async function callFeishuIntegrationOpenApiTextPreferUser(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>,
  options: PreferredAccessTokenOptions = {}
): Promise<string> {
  const { fallbackToTenant = true } = options;

  try {
    return await callFeishuIntegrationUserOpenApiText(integration, method, path, data);
  } catch (error) {
    if (!fallbackToTenant) {
      throw error;
    }

    logRuntimeMonitor(
      'warn',
      'integration_openapi',
      'integration_preferred_user_text_request_fallback_to_tenant',
      {
        integrationId: integration.id,
        method,
        path,
        ...toRuntimeErrorContext(error),
      }
    );
    return callFeishuIntegrationTenantOpenApiText(integration, method, path, data);
  }
}
