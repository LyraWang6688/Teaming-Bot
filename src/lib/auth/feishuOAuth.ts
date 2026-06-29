import {
  getFeishuLoginAppId,
  getFeishuLoginAppSecret,
  getFeishuLoginRedirectUri,
} from '@/lib/platform/env';

export function generateOauthState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Buffer.from(array).toString('base64url');
}

export function getFeishuOAuthUrl(state: string): string {
  const appId = getFeishuLoginAppId();
  const redirectUri = getFeishuLoginRedirectUri();

  const params = new URLSearchParams({
    app_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    scope: 'open_id email profile',
  });

  return `https://open.feishu.cn/open-apis/authen/v1/index?${params.toString()}`;
}

export interface FeishuUserInfo {
  openId: string;
  unionId?: string;
  name: string;
  enName?: string;
  avatarUrl?: string;
  email?: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export async function exchangeFeishuCode(code: string): Promise<FeishuUserInfo> {
  const appId = getFeishuLoginAppId();
  const appSecret = getFeishuLoginAppSecret();

  const appTokenRes = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }
  );
  const appTokenData = await appTokenRes.json();

  if (appTokenData.code !== 0) {
    throw new Error(`获取 app_access_token 失败：${appTokenData.msg}`);
  }

  const appAccessToken = appTokenData.app_access_token;

  const userTokenRes = await fetch(
    'https://open.feishu.cn/open-apis/authen/v1/access_token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${appAccessToken}`,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
      }),
    }
  );
  const userTokenData = await userTokenRes.json();

  if (userTokenData.code !== 0) {
    throw new Error(`飞书授权失败：${userTokenData.msg}`);
  }

  const data = userTokenData.data;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    openId: data.open_id,
    name: data.name,
    enName: data.en_name,
    avatarUrl: data.avatar_url,
    email: data.email,
    unionId: data.union_id,
  };
}
