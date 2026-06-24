import {
  getDefaultFeishuOauthScope,
  getProjectPublicUrl as getPlatformProjectPublicUrl,
} from '@/lib/platform/env';

export type FeishuBitableConfig = {
  appToken: string;
  tableId: string;
};

export function getProjectPublicUrl(): string {
  return getPlatformProjectPublicUrl();
}

export function getFeishuUserOauthRedirectUri(): string {
  return `${getProjectPublicUrl()}/api/feishu/oauth/callback`;
}

export function getFeishuUserOauthScope(): string {
  return getDefaultFeishuOauthScope();
}
