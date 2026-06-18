export type FeishuBitableConfig = {
  appToken: string;
  tableId: string;
};

export function getFeishuBitableConfig(): FeishuBitableConfig {
  const appToken = process.env.FEISHU_BASE_APP_TOKEN || '';
  const tableId = process.env.FEISHU_MEETING_TABLE_ID || '';

  if (!appToken || !tableId) {
    throw new Error('缺少 FEISHU_BASE_APP_TOKEN 或 FEISHU_MEETING_TABLE_ID');
  }

  return { appToken, tableId };
}

export function getProjectPublicUrl(): string {
  return (
    process.env.PROJECT_PUBLIC_URL ||
    'http://localhost:5000'
  ).replace(/\/$/, '');
}

export function getFeishuUserOauthRedirectUri(): string {
  return `${getProjectPublicUrl()}/api/feishu/oauth/callback`;
}

export function getFeishuUserOauthScope(): string {
  return process.env.FEISHU_USER_OAUTH_SCOPE || 'offline_access';
}

export function getFeishuAppCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.FEISHU_APP_ID || '';
  const appSecret = process.env.FEISHU_APP_SECRET || '';

  if (!appId || !appSecret) {
    throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');
  }

  return { appId, appSecret };
}

export function getFeishuUserAccessToken(): string {
  const accessToken = process.env.FEISHU_USER_ACCESS_TOKEN || '';

  if (!accessToken) {
    throw new Error('缺少 FEISHU_USER_ACCESS_TOKEN');
  }

  return accessToken;
}

export function getFeishuUserRefreshToken(): string | null {
  const refreshToken = process.env.FEISHU_USER_REFRESH_TOKEN || '';
  return refreshToken || null;
}

export function getFeishuUserAccessTokenExpiresAt(): number | null {
  const rawValue = process.env.FEISHU_USER_ACCESS_TOKEN_EXPIRES_AT || '';
  if (!rawValue) {
    return null;
  }

  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric > 10_000_000_000 ? numeric : numeric * 1000;
}
