/**
 * 回填「宿主通道报告」的 Base 同步任务。
 *
 * ## 背景
 *
 * `/api/host/v1/reports` 过去没有调用 enqueueBaseSyncTask —— 报告落 Supabase，
 * 但 meeting_base_sync_tasks 里没有任务行，deliveryWorker 永远看不到，
 * 所以不会出现在多维表格里。
 *
 * 代码已修（commit 1375adb），但**对已经写进去的记录无效**：它们没有任务行。
 * 这个脚本就是给它们补登记；登记之后 worker（每 5 秒一轮）会自动完成同步。
 *
 * ## 归属后置
 *
 * 与网页版不同，宿主通道没有「初始化时选项目/方向」这一步，所以：
 *   · 项目 = 当前活跃期（任一时刻只有一期 active）
 *   · 方向 = 留空（skipDirection: true），由运营侧在多维表格里自己选
 *
 * ## 用法
 *
 *   node scripts/backfillHostReportBaseSync.mjs            # 默认 dry-run，只打印
 *   node scripts/backfillHostReportBaseSync.mjs --apply    # 真正写入
 *   node scripts/backfillHostReportBaseSync.mjs --limit 5  # 限制条数
 *
 * ## 幂等
 *
 * 复用与 enqueueBaseSyncTask 相同的 (meeting_record_id, target_key) 冲突语义，
 * 重复执行不会产生重复任务行。
 */
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
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY_RUN = !APPLY;

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const LIMIT = Number(argValue('--limit') || 50);

async function main() {
  const pool = new Pool({ connectionString: requiredEnv('DATABASE_URL') });
  const client = await pool.connect();

  try {
    // ① 当前活跃期（任一时刻只有一期 active，见 README/项目配置脚本）
    const projectRes = await client.query(
      `select id, project_key, name, bitable_app_token_encrypted, bitable_table_id
         from feishu_projects
        where status = 'active'
        order by updated_at desc
        limit 1`
    );
    const project = projectRes.rows[0];
    if (!project) throw new Error('没有活跃期（feishu_projects.status = active）。');

    const tableId = project.bitable_table_id;
    if (!tableId) throw new Error(`活跃期 ${project.project_key} 没有配置 bitable_table_id。`);
    if (!project.bitable_app_token_encrypted) {
      throw new Error(`活跃期 ${project.project_key} 没有配置多维表格 appToken。`);
    }

    // ② 方向：只用来通过「目标必须存在且属于同一项目」的校验；不写进 Base
    const targetRes = await client.query(
      `select id, org_name from feishu_project_org_targets
        where project_id = $1 and enabled = true
        order by org_name limit 1`,
      [project.id]
    );
    const target = targetRes.rows[0];
    if (!target) throw new Error(`活跃期 ${project.project_key} 下没有可用的方向（org_target）。`);

    console.log('【目标】');
    console.log(`  活跃期    ${project.name}（${project.project_key}）`);
    console.log(`  表        ${tableId}`);
    console.log(`  占位方向  ${target.org_name}（不会写进 Base）`);
    console.log(`  模式      ${DRY_RUN ? 'DRY-RUN（只打印，不写入）' : 'APPLY（真正写入）'}`);
    console.log();

    // ③ 待回填记录：已完成 + 没有 base_record_id + 没有项目归属（= 经宿主通道写入）
    const rowsRes = await client.query(
      `select m.id, m.topic, m.integration_id, m.user_id, m.data_version,
              to_char(m.created_at at time zone 'Asia/Shanghai', 'MM-DD HH24:MI') as created
         from meeting_records m
        where m.status = 'completed'
          and m.base_record_id is null
          and m.project_id is null
        order by m.created_at
        limit $1`,
      [LIMIT]
    );

    const rows = rowsRes.rows;
    console.log(`【待回填】${rows.length} 条`);
    for (const row of rows) {
      console.log(`  ${row.id.slice(0, 8)}  ${row.created}  ${row.topic || '(无标题)'}`);
    }
    console.log();

    if (rows.length === 0) {
      console.log('没有需要回填的记录。');
      return;
    }

    if (DRY_RUN) {
      console.log('DRY-RUN：没有写入任何数据。确认无误后加 --apply 执行。');
      return;
    }

    // snapshot 里要的是【加密后】的 appToken，而项目行里存的本来就是密文，
    // 所以直接复用即可 —— 运行时 decrypt(snapshot.appTokenEncrypted) 能正常解出。
    // （脚本不 import TS 源码：服务器上没有 ts-node。）
    const appTokenEncrypted = project.bitable_app_token_encrypted;

    let inserted = 0;
    for (const row of rows) {
      const snapshot = JSON.stringify({
        projectId: project.id,
        orgTargetId: target.id,
        orgName: null,
        appTokenEncrypted,
        tableId,
        skipDirection: true,
      });

      const res = await client.query(
        `insert into meeting_base_sync_tasks (
           meeting_record_id, integration_id, user_id, project_id, org_target_id,
           target_key, target_config_snapshot, mapping_version,
           requested_version, synced_version, status, next_run_at,
           base_record_id, last_error_code, last_error_summary,
           created_at, updated_at
         ) values (
           $1, $2, $3, $4, $5,
           $6, $7::jsonb, null,
           $8, 0, 'pending', now(),
           null, null, null,
           now(), now()
         )
         on conflict (meeting_record_id, target_key) do update set
           requested_version = greatest(excluded.requested_version, meeting_base_sync_tasks.requested_version),
           target_config_snapshot = excluded.target_config_snapshot,
           project_id = excluded.project_id,
           org_target_id = excluded.org_target_id,
           status = case
             when meeting_base_sync_tasks.status = 'succeeded' then meeting_base_sync_tasks.status
             else 'pending'
           end,
           next_run_at = case
             when meeting_base_sync_tasks.status = 'succeeded' then meeting_base_sync_tasks.next_run_at
             else now()
           end,
           updated_at = now()
         returning (xmax = 0) as inserted`,
        [
          row.id, row.integration_id, row.user_id, project.id, target.id,
          `project:${project.id}`, snapshot,
          row.data_version ?? 1,
        ]
      );
      if (res.rows[0]?.inserted) inserted += 1;
      console.log(`  ✓ ${row.id.slice(0, 8)}  ${row.topic || '(无标题)'}`);
    }

    console.log();
    console.log(`已登记 ${rows.length} 条（其中新建 ${inserted} 条，其余为已存在的任务行被重新排队）。`);
    console.log('deliveryWorker 每 5 秒一轮，稍后它们会被写入多维表格（「方向」留空）。');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('回填失败：', error?.message || error);
  process.exit(1);
});
