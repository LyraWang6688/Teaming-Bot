import {
  getFeishuAppCredentials,
  getFeishuUserAccessToken,
  getFeishuUserAccessTokenExpiresAt,
  getFeishuUserRefreshToken,
} from './config';
import { logFeishuMonitor, toErrorContext } from './monitor';

type TenantAccessTokenResponse = {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
};

type UserAccessTokenRefreshResponse = {
  code: number;
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  msg?: string;
  error?: string;
  error_description?: string;
};

export type FeishuApiResponse<T = unknown> = {
  code: number;
  msg?: string;
  data?: T;
};

let cachedTenantToken: {
  token: string;
  expiresAt: number;
} | null = null;

let cachedUserToken:
  | {
      accessToken: string | null;
      accessTokenExpiresAt: number | null;
      refreshToken: string | null;
      refreshTokenExpiresAt: number | null;
    }
  | null = null;

const FEISHU_OPENAPI_BASE_URL = 'https://open.feishu.cn/open-apis';

export class FeishuOpenApiError extends Error {
  statusCode?: number;
  code?: number;
  method: string;
  path: string;
  body?: string;

  constructor(options: {
    message: string;
    method: string;
    path: string;
    statusCode?: number;
    code?: number;
    body?: string;
  }) {
    super(options.message);
    this.name = 'FeishuOpenApiError';
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.method = options.method;
    this.path = options.path;
    this.body = options.body;
  }
}

export async function getTenantAccessToken(): Promise<string> {
  if (cachedTenantToken && cachedTenantToken.expiresAt > Date.now() + 60_000) {
    return cachedTenantToken.token;
  }

  const { appId, appSecret } = getFeishuAppCredentials();
  const response = await fetch(`${FEISHU_OPENAPI_BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret,
    }),
  });

  const data = (await response.json()) as TenantAccessTokenResponse;
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(data.msg || `获取 tenant_access_token 失败: HTTP ${response.status}`);
  }

  cachedTenantToken = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + Math.max((data.expire || 7200) - 120, 60) * 1000,
  };

  return cachedTenantToken.token;
}

function buildFeishuOpenApiUrl(path: string): string {
  return `${FEISHU_OPENAPI_BASE_URL}${path}`;
}

function getInitialUserAccessToken(): string | null {
  try {
    return getFeishuUserAccessToken();
  } catch {
    return null;
  }
}

function ensureUserTokenState() {
  if (cachedUserToken) {
    return;
  }

  cachedUserToken = {
    accessToken: getInitialUserAccessToken(),
    accessTokenExpiresAt: getFeishuUserAccessTokenExpiresAt(),
    refreshToken: getFeishuUserRefreshToken(),
    refreshTokenExpiresAt: null,
  };
}

async function refreshUserAccessToken(): Promise<string> {
  ensureUserTokenState();
  const refreshToken = cachedUserToken?.refreshToken;

  if (!refreshToken) {
    logFeishuMonitor('warn', 'user_token_refresh_missing_refresh_token');
    throw new Error('缺少 FEISHU_USER_REFRESH_TOKEN，无法刷新 user_access_token');
  }

  const { appId, appSecret } = getFeishuAppCredentials();
  const path = '/authen/v2/oauth/token';
  const response = await fetch(buildFeishuOpenApiUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: appId,
      client_secret: appSecret,
      refresh_token: refreshToken,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as UserAccessTokenRefreshResponse;
  if (!response.ok || payload.code !== 0 || !payload.access_token) {
    logFeishuMonitor('error', 'user_token_refresh_failed', {
      statusCode: response.status,
      code: payload.code,
      message: payload.error_description || payload.msg || payload.error,
    });
    throw new FeishuOpenApiError({
      message:
        payload.error_description ||
        payload.msg ||
        payload.error ||
        `刷新 user_access_token 失败: HTTP ${response.status}`,
      method: 'POST',
      path,
      statusCode: response.status,
      code: payload.code,
    });
  }

  cachedUserToken = {
    accessToken: payload.access_token,
    accessTokenExpiresAt: Date.now() + Math.max((payload.expires_in || 7200) - 120, 60) * 1000,
    refreshToken: payload.refresh_token || null,
    refreshTokenExpiresAt: payload.refresh_token
      ? Date.now() + Math.max((payload.refresh_token_expires_in || 604800) - 300, 60) * 1000
      : null,
  };

  logFeishuMonitor('info', 'user_token_refreshed', {
    accessTokenExpiresAt: cachedUserToken.accessTokenExpiresAt,
    refreshTokenExpiresAt: cachedUserToken.refreshTokenExpiresAt,
  });

  return cachedUserToken.accessToken!;
}

export async function getUserAccessToken(forceRefresh = false): Promise<string> {
  ensureUserTokenState();

  if (
    !forceRefresh &&
    cachedUserToken?.accessToken &&
    (!cachedUserToken.accessTokenExpiresAt ||
      cachedUserToken.accessTokenExpiresAt > Date.now() + 60_000)
  ) {
    return cachedUserToken.accessToken;
  }

  if (cachedUserToken?.refreshToken) {
    return refreshUserAccessToken();
  }

  if (cachedUserToken?.accessToken && !forceRefresh) {
    return cachedUserToken.accessToken;
  }

  throw new Error('缺少可用的 FEISHU_USER_ACCESS_TOKEN / FEISHU_USER_REFRESH_TOKEN');
}

function shouldRetryUserRequest(error: unknown): boolean {
  return (
    error instanceof FeishuOpenApiError &&
    (error.statusCode === 401 || error.statusCode === 403)
  );
}

async function callFeishuOpenApiWithAccessToken<T = unknown>(
  accessToken: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  data?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(buildFeishuOpenApiUrl(path), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: method === 'GET' ? undefined : JSON.stringify(data || {}),
  });

  const payload = (await response.json().catch(() => ({}))) as FeishuApiResponse<T>;
  if (!response.ok || payload.code !== 0) {
    throw new FeishuOpenApiError({
      message: payload.msg || `飞书 OpenAPI 调用失败: ${method} ${path} HTTP ${response.status}`,
      method,
      path,
      statusCode: response.status,
      code: payload.code,
    });
  }

  return payload.data as T;
}

async function callFeishuOpenApiTextWithAccessToken(
  accessToken: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  data?: Record<string, unknown>
): Promise<string> {
  const response = await fetch(buildFeishuOpenApiUrl(path), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: method === 'GET' ? undefined : JSON.stringify(data || {}),
  });

  const text = await response.text();
  if (!response.ok) {
    let errorCode: number | undefined;
    let errorMessage = text || `飞书 OpenAPI 调用失败: ${method} ${path} HTTP ${response.status}`;

    try {
      const payload = JSON.parse(text) as FeishuApiResponse;
      errorCode = payload.code;
      errorMessage = payload.msg || errorMessage;
    } catch {
      // 文本接口成功时通常返回纯文本；失败时若不是 JSON，则直接透传原始文本。
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

export async function callFeishuOpenApi<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  data?: Record<string, unknown>
): Promise<T> {
  const token = await getTenantAccessToken();
  return callFeishuOpenApiWithAccessToken<T>(token, method, path, data);
}

export async function callFeishuUserOpenApi<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  data?: Record<string, unknown>
): Promise<T> {
  const token = await getUserAccessToken();

  try {
    return await callFeishuOpenApiWithAccessToken<T>(token, method, path, data);
  } catch (error) {
    if (!shouldRetryUserRequest(error)) {
      throw error;
    }

    logFeishuMonitor('warn', 'user_request_retry_after_auth_error', {
      method,
      path,
      ...toErrorContext(error),
    });
    const refreshedToken = await getUserAccessToken(true);
    return callFeishuOpenApiWithAccessToken<T>(refreshedToken, method, path, data);
  }
}

export async function callFeishuOpenApiText(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  data?: Record<string, unknown>
): Promise<string> {
  const token = await getTenantAccessToken();
  return callFeishuOpenApiTextWithAccessToken(token, method, path, data);
}

export async function callFeishuUserOpenApiText(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  data?: Record<string, unknown>
): Promise<string> {
  const token = await getUserAccessToken();

  try {
    return await callFeishuOpenApiTextWithAccessToken(token, method, path, data);
  } catch (error) {
    if (!shouldRetryUserRequest(error)) {
      throw error;
    }

    logFeishuMonitor('warn', 'user_text_request_retry_after_auth_error', {
      method,
      path,
      ...toErrorContext(error),
    });
    const refreshedToken = await getUserAccessToken(true);
    return callFeishuOpenApiTextWithAccessToken(refreshedToken, method, path, data);
  }
}
