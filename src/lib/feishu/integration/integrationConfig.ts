import { getProjectPublicUrl } from '@/lib/platform/env';

export function getFeishuOauthCallbackUrl(): string {
  return `${getProjectPublicUrl()}/api/feishu/oauth/callback`;
}

export function getFeishuOauthSuccessRedirect(integrationId: string): string {
  return `/feishu-config?integrationId=${encodeURIComponent(integrationId)}&oauth=success`;
}
