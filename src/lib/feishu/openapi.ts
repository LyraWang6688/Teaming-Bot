import { getFeishuAppCredentials } from './config';

type TenantAccessTokenResponse = {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
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

const FEISHU_OPENAPI_BASE_URL = 'https://open.feishu.cn/open-apis';

async function getTenantAccessToken(): Promise<string> {
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

export async function callFeishuOpenApi<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  data?: Record<string, unknown>
): Promise<T> {
  const token = await getTenantAccessToken();
  const response = await fetch(`${FEISHU_OPENAPI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: method === 'GET' ? undefined : JSON.stringify(data || {}),
  });

  const payload = (await response.json().catch(() => ({}))) as FeishuApiResponse<T>;
  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || `飞书 OpenAPI 调用失败: ${method} ${path} HTTP ${response.status}`);
  }

  return payload.data as T;
}
