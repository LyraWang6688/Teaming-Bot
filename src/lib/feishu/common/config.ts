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

export function getFeishuUserOauthScope(): string {
  return getDefaultFeishuOauthScope();
}
