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

export function getFeishuAppCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.FEISHU_APP_ID || '';
  const appSecret = process.env.FEISHU_APP_SECRET || '';

  if (!appId || !appSecret) {
    throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');
  }

  return { appId, appSecret };
}
