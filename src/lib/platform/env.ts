const DEFAULT_FEISHU_USER_OAUTH_SCOPE =
  'minutes:minutes.basic:read minutes:minutes.transcript:export offline_access bitable:app';

function getRequiredValue(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`缺少环境变量 ${name}`);
  }

  return normalized;
}

export function getProjectPublicUrl(): string {
  return (process.env.PROJECT_PUBLIC_URL || 'http://localhost:5000').replace(/\/$/, '');
}

export function getDatabaseUrl(): string {
  return getRequiredValue('DATABASE_URL', process.env.DATABASE_URL);
}

export function getSupabaseUrl(): string {
  return getRequiredValue('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL);
}

export function getSupabaseAnonKey(): string {
  return getRequiredValue(
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function getSupabaseServiceRoleKey(): string {
  return getRequiredValue('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getAppEncryptionKey(): string {
  return getRequiredValue('APP_ENCRYPTION_KEY', process.env.APP_ENCRYPTION_KEY);
}

export function getDefaultFeishuOauthScope(): string {
  return process.env.FEISHU_USER_OAUTH_SCOPE?.trim() || DEFAULT_FEISHU_USER_OAUTH_SCOPE;
}
