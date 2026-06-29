/**
 * 飞书官方 SDK 客户端封装
 *
 * 说明：本模块为新增模块，不影响现有代码。
 * 依赖：@larksuiteoapi/node-sdk（需单独安装）
 *
 * 使用方式：
 *   1. 调用 createLarkClient 创建客户端
 *   2. 使用客户端调用各业务 API
 */

import type { Client } from '@larksuiteoapi/node-sdk';

export interface LarkClientConfig {
  /** 应用 App ID */
  appId: string;
  /** 应用 App Secret */
  appSecret: string;
  /** 域名：feishu / lark */
  domain?: 'feishu' | 'lark';
  /** 用户访问令牌（用户身份调用时需要） */
  userAccessToken?: string;
}

export interface LarkUserTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

let larkSdkModule: typeof import('@larksuiteoapi/node-sdk') | null = null;

async function loadLarkSdk(): Promise<typeof import('@larksuiteoapi/node-sdk')> {
  if (larkSdkModule) {
    return larkSdkModule;
  }

  try {
    larkSdkModule = await import('@larksuiteoapi/node-sdk');
    return larkSdkModule;
  } catch (error) {
    throw new Error(
      `飞书 SDK 未安装，请先执行：pnpm add @larksuiteoapi/node-sdk。原始错误：${(error as Error).message}`
    );
  }
}

/**
 * 创建飞书 SDK 客户端（应用身份）
 *
 * 用于调用应用权限的 API，如获取 tenant_access_token 等
 */
export async function createLarkAppClient(config: LarkClientConfig): Promise<Client> {
  const sdk = await loadLarkSdk();

  const domain = config.domain === 'lark' ? 'lark' : 'feishu';

  return new sdk.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
  });
}

/**
 * 创建飞书 SDK 客户端（用户身份）
 *
 * 用于调用用户权限的 API，如获取妙记、操作多维表格等
 * 
 * 注意：SDK 的用户身份调用需要在每次请求时通过 options.lark[CWithUserAccessToken] 传入
 * 这里创建的是基础客户端，实际调用时需要通过 request options 传入 userAccessToken
 */
export async function createLarkUserClient(
  config: LarkClientConfig & { userAccessToken: string }
): Promise<Client> {
  const sdk = await loadLarkSdk();

  const domain = config.domain === 'lark' ? 'lark' : 'feishu';

  return new sdk.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
  });
}

/**
 * 用 refresh_token 刷新用户访问令牌
 */
export async function refreshUserAccessToken(
  appId: string,
  appSecret: string,
  refreshToken: string,
  domain: 'feishu' | 'lark' = 'feishu'
): Promise<LarkUserTokens> {
  const baseUrl = domain === 'feishu'
    ? 'https://open.feishu.cn/open-apis'
    : 'https://open.larksuite.com/open-apis';

  const appTokenRes = await fetch(`${baseUrl}/auth/v3/app_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const appTokenData = await appTokenRes.json();

  if (appTokenData.code !== 0) {
    throw new Error(`获取应用令牌失败：${appTokenData.msg || appTokenData.error_description}`);
  }

  const userTokenRes = await fetch(`${baseUrl}/authen/v1/refresh_access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${appTokenData.app_access_token}`,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  const userTokenData = await userTokenRes.json();

  if (userTokenData.code !== 0) {
    throw new Error(`刷新用户令牌失败：${userTokenData.msg || userTokenData.error_description}`);
  }

  return {
    accessToken: userTokenData.data.access_token,
    refreshToken: userTokenData.data.refresh_token,
    expiresIn: userTokenData.data.expires_in,
  };
}

export type { Client as LarkClient };
