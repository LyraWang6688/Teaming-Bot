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
  const baseUrl = String(raw.baseUrl || '').trim();
  const targets = Array.isArray(raw.organizationTargets) ? raw.organizationTargets : [];

  if (!projectKey) throw new Error('配置缺少 projectKey。');
  if (!projectName) throw new Error('配置缺少 projectName。');
  if (!baseUrl) throw new Error('配置缺少 baseUrl（项目级别的多维表格链接）。');
  if (targets.length === 0) throw new Error('配置缺少 organizationTargets。');

  return {
    projectKey,
    projectName,
    baseUrl,
    status: String(raw.status || 'active').trim(),
    startsAt: raw.startsAt ? new Date(raw.startsAt) : null,
    endsAt: raw.endsAt ? new Date(raw.endsAt) : null,
    organizationTargets: targets.map((target, index) => ({
      orgKey: String(target.orgKey || '').trim(),
      orgName: String(target.orgName || '').trim(),
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

  logImportMonitor('info', 'project_config_import_started', {
    configPath,
    projectKey: config.projectKey,
    projectName: config.projectName,
    status: config.status,
    targetCount: config.organizationTargets.length,
  });

  const { appToken, tableId } = parseBaseUrl(config.baseUrl);

  for (const target of config.organizationTargets) {
    if (!target.orgKey || !target.orgName) {
      throw new Error(`第 ${target.index + 1} 个组织配置缺少 orgKey 或 orgName。`);
    }
  }

  const pool = new Pool({ connectionString: requiredEnv('DATABASE_URL') });
  const client = await pool.connect();

  try {
    await client.query('begin');

    if (config.status === 'active') {
      // 1. 旧 active 项目归档
      const archivedProjectsResult = await client.query(
        `update feishu_projects set status = 'archived', updated_at = now()
         where status = 'active' and project_key <> $1
         returning id, project_key, name`,
        [config.projectKey]
      );

      // 2. 级联失活旧项目下所有未删除、当前仍 active 的集成（直接通过 project_id 绑定）
      const archivedProjectIds = archivedProjectsResult.rows.map((row) => row.id);
      if (archivedProjectIds.length > 0) {
        const deactivatedResult = await client.query(
          `update feishu_integrations
             set is_active = false,
                 status = 'archived',
                 superseded_by_integration_id = null,
                 updated_at = now()
           where is_active = true
             and deleted_at is null
             and project_id = any($1::uuid[])
           returning id, user_id, project_id, selected_org_target_id`,
          [archivedProjectIds]
        );

        // 3. 写审计日志（每个被失活的集成一条）
        for (const row of deactivatedResult.rows) {
          await client.query(
            `insert into feishu_audit_logs
               (integration_id, user_id, action, result, summary, metadata, created_at)
             values ($1, $2, $3, $4, $5, $6, now())`,
            [
              row.id,
              row.user_id,
              'integration.project_archived_cascade_deactivate',
              'success',
              `所属项目被归档，集成自动失活（new project: ${config.projectKey}）`,
              {
                reason: 'project_archived',
                newActiveProjectKey: config.projectKey,
                archivedProjectIds,
                projectId: row.project_id,
                selectedOrgTargetId: row.selected_org_target_id,
              },
            ]
          );
        }
      }
    }

    const projectResult = await client.query(
      `
        insert into feishu_projects (project_key, name, status, starts_at, ends_at, bitable_app_token_encrypted, bitable_table_id, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, now())
        on conflict (project_key)
        do update set
          name = excluded.name,
          status = excluded.status,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          bitable_app_token_encrypted = excluded.bitable_app_token_encrypted,
          bitable_table_id = excluded.bitable_table_id,
          updated_at = now()
        returning id
      `,
      [config.projectKey, config.projectName, config.status, config.startsAt, config.endsAt, encrypt(appToken), tableId]
    );

    const projectId = projectResult.rows[0].id;
    const orgKeys = config.organizationTargets.map((target) => target.orgKey);

    for (const target of config.organizationTargets) {
      await client.query(
        `
          insert into feishu_project_org_targets (
            project_id,
            org_key,
            org_name,
            enabled,
            updated_at
          )
          values ($1, $2, $3, $4, now())
          on conflict (project_id, org_key)
          do update set
            org_name = excluded.org_name,
            enabled = excluded.enabled,
            updated_at = now()
        `,
        [
          projectId,
          target.orgKey,
          target.orgName,
          target.enabled,
        ]
      );
    }

    if (orgKeys.length > 0) {
      await client.query(
        `
          update feishu_project_org_targets
          set enabled = false, updated_at = now()
          where project_id = $1
            and org_key <> all($2::text[])
        `,
        [projectId, orgKeys]
      );
    }

    await client.query('commit');

    logImportMonitor('info', 'project_config_import_completed', {
      projectKey: config.projectKey,
      projectName: config.projectName,
      projectId,
      tableId,
      targetCount: config.organizationTargets.length,
    });

    console.log(`项目 ${config.projectName} 导入完成。`);
    console.log(`多维表格：${tableId}`);
    console.log(`组织：${config.organizationTargets.map((item) => item.orgName).join('、')}`);
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
