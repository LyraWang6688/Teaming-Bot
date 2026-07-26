import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import pg from 'pg';

const { Pool } = pg;

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1');
  }
}

for (const fileName of ['.env', '.env.local', '.env.production']) {
  loadEnvFile(resolve(process.cwd(), fileName));
}

export function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

export function parseArgs(argv) {
  const options = {
    apply: false,
    confirmDeleteFields: false,
    projectKey: null,
    orgKey: null,
    limit: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') options.apply = true;
    else if (value === '--confirm-delete-fields') options.confirmDeleteFields = true;
    else if (value === '--project-key') options.projectKey = argv[++index] || null;
    else if (value === '--org-key') options.orgKey = argv[++index] || null;
    else if (value === '--limit') options.limit = Number(argv[++index] || 0) || null;
    else throw new Error(`未知参数：${value}`);
  }

  return options;
}

export function logMigration(scope, level, event, context = {}) {
  const line = `[Runtime Monitor] ${JSON.stringify({
    ...context,
    timestamp: new Date().toISOString(),
    scope,
    event,
  })}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function decrypt(value) {
  const [version, ivValue, authTagValue, ciphertextValue] = String(value || '').split(':');
  if (version !== 'enc-v1' || !ivValue || !authTagValue || !ciphertextValue) {
    throw new Error('数据库中的密文格式无效。');
  }

  const key = createHash('sha256').update(requiredEnv('APP_ENCRYPTION_KEY')).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(authTagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function createPool() {
  return new Pool({ connectionString: requiredEnv('DATABASE_URL') });
}

export async function listMigrationTargets(pool, options) {
  const clauses = ['target.enabled = true', 'integration.id is not null', 'authorization.id is not null'];
  const values = [];

  if (options.projectKey) {
    values.push(options.projectKey);
    clauses.push(`project.project_key = $${values.length}`);
  }
  if (options.orgKey) {
    values.push(options.orgKey);
    clauses.push(`target.org_key = $${values.length}`);
  }

  const result = await pool.query(
    `
      select
        project.id as project_id,
        project.project_key,
        project.name as project_name,
        target.id as org_target_id,
        target.org_key,
        target.org_name,
        target.base_app_token_encrypted,
        target.table_id,
        integration.id as integration_id,
        integration.user_id,
        authorization.access_token_encrypted,
        authorization.access_token_expires_at
      from public.feishu_project_org_targets target
      inner join public.feishu_projects project on project.id = target.project_id
      left join lateral (
        select fi.*
        from public.feishu_integrations fi
        where fi.selected_org_target_id = target.id
          and fi.deleted_at is null
          and fi.is_active = true
        order by fi.updated_at desc
        limit 1
      ) integration on true
      left join public.feishu_authorizations authorization
        on authorization.integration_id = integration.id
       and authorization.status = 'authorized'
      where ${clauses.join(' and ')}
      order by project.created_at asc, target.created_at asc
    `,
    values
  );

  return result.rows.map((row) => ({
    ...row,
    baseAppToken: decrypt(row.base_app_token_encrypted),
    accessToken: decrypt(row.access_token_encrypted),
  }));
}

export async function callFeishuOpenApi(target, method, path, data) {
  if (new Date(target.access_token_expires_at).getTime() <= Date.now()) {
    throw new Error('当前组织对应的用户 access_token 已过期，请先在配置页重新校验或授权。');
  }

  const response = await fetch(`https://open.feishu.cn/open-apis${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${target.accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || (typeof payload.code === 'number' && payload.code !== 0)) {
    const error = new Error(payload.msg || `飞书 OpenAPI 请求失败：HTTP ${response.status}`);
    error.statusCode = response.status;
    error.code = payload.code;
    throw error;
  }

  return payload.data || payload;
}

export function extractBitableText(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof item.text === 'string') return item.text;
        return '';
      })
      .join('')
      .trim();
    return text || null;
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') {
    return value.text.trim() || null;
  }
  return null;
}
