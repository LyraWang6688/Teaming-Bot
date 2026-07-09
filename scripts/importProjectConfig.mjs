import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
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
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
}

loadEnvFile(resolve(process.cwd(), '.env'));
loadEnvFile(resolve(process.cwd(), '.env.local'));
loadEnvFile(resolve(process.cwd(), '.env.production'));

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

function logImportMonitor(level, event, context = {}) {
  const payload = {
    ...context,
    timestamp: new Date().toISOString(),
    scope: 'project_config_import',
    event,
  };

  const line = `[Runtime Monitor] ${JSON.stringify(payload)}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function encrypt(value) {
  const iv = randomBytes(12);
  const key = createHash('sha256').update(requiredEnv('APP_ENCRYPTION_KEY')).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ['enc-v1', iv.toString('base64url'), authTag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

function parseBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Base 链接格式不正确。');
  }

  const match = url.pathname.match(/\/base\/([^/?#]+)/);
  const appToken = match?.[1];
  const tableId = url.searchParams.get('table') || url.searchParams.get('table_id');

  if (!appToken || !tableId) {
    throw new Error('Base 链接中未识别到 appToken 或 tableId。');
  }

  return { appToken, tableId };
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('项目配置必须是 JSON 对象。');
  const projectKey = String(raw.projectKey || '').trim();
  const projectName = String(raw.projectName || raw.name || '').trim();
  const targets = Array.isArray(raw.organizationTargets) ? raw.organizationTargets : [];

  if (!projectKey) throw new Error('配置缺少 projectKey。');
  if (!projectName) throw new Error('配置缺少 projectName。');
  if (targets.length === 0) throw new Error('配置缺少 organizationTargets。');

  return {
    projectKey,
    projectName,
    status: String(raw.status || 'active').trim(),
    startsAt: raw.startsAt ? new Date(raw.startsAt) : null,
    endsAt: raw.endsAt ? new Date(raw.endsAt) : null,
    organizationTargets: targets.map((target, index) => ({
      orgKey: String(target.orgKey || '').trim(),
      orgName: String(target.orgName || '').trim(),
      baseUrl: String(target.baseUrl || '').trim(),
      enabled: target.enabled !== false,
      index,
    })),
  };
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    throw new Error('用法：pnpm import:project-config ./configs/projects/2026-07-m-project.json');
  }

  const config = normalizeConfig(JSON.parse(readFileSync(resolve(process.cwd(), configPath), 'utf8')));
  const successful = [];
  const failed = [];

  logImportMonitor('info', 'project_config_import_started', {
    configPath,
    projectKey: config.projectKey,
    projectName: config.projectName,
    status: config.status,
    targetCount: config.organizationTargets.length,
  });

  for (const target of config.organizationTargets) {
    try {
      if (!target.orgKey || !target.orgName || !target.baseUrl) {
        throw new Error(`第 ${target.index + 1} 个组织配置缺少 orgKey、orgName 或 baseUrl。`);
      }

      const { appToken, tableId } = parseBaseUrl(target.baseUrl);
      successful.push({
        ...target,
        appToken,
        tableId,
        fieldCheckDetails: {
          status: 'pending',
          message: '字段模板将在首个授权用户完成系统校验时检查并缓存。',
          importedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logImportMonitor('warn', 'project_config_target_parse_failed', {
        projectKey: config.projectKey,
        orgKey: target.orgKey || null,
        orgName: target.orgName || null,
        reason: error instanceof Error ? error.message : String(error),
      });
      failed.push({
        orgKey: target.orgKey,
        orgName: target.orgName,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (successful.length === 0) {
    logImportMonitor('error', 'project_config_import_failed_no_successful_targets', {
      projectKey: config.projectKey,
      projectName: config.projectName,
      failedCount: failed.length,
      failedTargets: failed.map((item) => ({
        orgKey: item.orgKey || null,
        orgName: item.orgName || null,
        reason: item.reason,
      })),
    });
    console.error('项目配置导入失败：没有任何组织通过校验。');
    for (const item of failed) {
      console.error(`- ${item.orgName || item.orgKey || '未知组织'}：${item.reason}`);
    }
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: requiredEnv('DATABASE_URL') });
  const client = await pool.connect();

  try {
    await client.query('begin');

    if (config.status === 'active') {
      await client.query(`update feishu_projects set status = 'archived', updated_at = now() where status = 'active' and project_key <> $1`, [
        config.projectKey,
      ]);
    }

    const projectResult = await client.query(
      `
        insert into feishu_projects (project_key, name, status, starts_at, ends_at, updated_at)
        values ($1, $2, $3, $4, $5, now())
        on conflict (project_key)
        do update set
          name = excluded.name,
          status = excluded.status,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          updated_at = now()
        returning id
      `,
      [config.projectKey, config.projectName, config.status, config.startsAt, config.endsAt]
    );

    const projectId = projectResult.rows[0].id;
    const successfulOrgKeys = successful.map((target) => target.orgKey);
    const failedOrgKeys = failed.map((target) => target.orgKey).filter(Boolean);

    for (const target of successful) {
      await client.query(
        `
          insert into feishu_project_org_targets (
            project_id,
            org_key,
            org_name,
            base_app_token_encrypted,
            table_id,
            base_url,
            enabled,
            field_check_status,
            field_check_details,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::jsonb, now())
          on conflict (project_id, org_key)
          do update set
            org_name = excluded.org_name,
            base_app_token_encrypted = excluded.base_app_token_encrypted,
            table_id = excluded.table_id,
            base_url = excluded.base_url,
            enabled = excluded.enabled,
            field_check_status = 'pending',
            field_check_details = excluded.field_check_details,
            updated_at = now()
        `,
        [
          projectId,
          target.orgKey,
          target.orgName,
          encrypt(target.appToken),
          target.tableId,
          target.baseUrl,
          target.enabled,
          JSON.stringify(target.fieldCheckDetails),
        ]
      );
    }

    if (successfulOrgKeys.length > 0) {
      await client.query(
        `
          update feishu_project_org_targets
          set enabled = false, updated_at = now()
          where project_id = $1
            and org_key <> all($2::text[])
        `,
        [projectId, successfulOrgKeys]
      );
    }

    if (failedOrgKeys.length > 0) {
      await client.query(
        `
          update feishu_project_org_targets
          set enabled = false, field_check_status = 'failed', updated_at = now()
          where project_id = $1
            and org_key = any($2::text[])
        `,
        [projectId, failedOrgKeys]
      );
    }

    await client.query('commit');

    logImportMonitor(failed.length > 0 ? 'warn' : 'info', failed.length > 0 ? 'project_config_import_partial_completed' : 'project_config_import_completed', {
      projectKey: config.projectKey,
      projectName: config.projectName,
      projectId,
      successfulCount: successful.length,
      failedCount: failed.length,
      successfulTargets: successful.map((item) => ({
        orgKey: item.orgKey,
        orgName: item.orgName,
        tableId: item.tableId,
      })),
      failedTargets: failed.map((item) => ({
        orgKey: item.orgKey || null,
        orgName: item.orgName || null,
        reason: item.reason,
      })),
    });

    console.log(`项目 ${config.projectName} 导入完成。`);
    console.log(`成功组织：${successful.map((item) => item.orgName).join('、')}`);
    if (failed.length > 0) {
      console.log('失败组织：');
      for (const item of failed) {
        console.log(`- ${item.orgName || item.orgKey}：${item.reason}`);
      }
    }
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  logImportMonitor('error', 'project_config_import_unhandled_failed', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
    errorMessage: error instanceof Error ? error.message : String(error),
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
