#!/usr/bin/env node
/**
 * 生成宿主接入码。
 *
 * 用法：
 *   node scripts/createHostEnrollmentCode.mjs --integration <集成ID> [--label 给谁用] [--max-uses 5] [--days 30]
 *   node scripts/createHostEnrollmentCode.mjs --list
 *   node scripts/createHostEnrollmentCode.mjs --revoke <接入码>
 *
 * 生成后把码发给用户，让他在宿主里执行：
 *   npx teaming-mcp setup --code <接入码>
 *
 * 说明：这里直接连库（运营侧工具，不是服务端运行时），
 * 所以**不经过** src/lib/host/hostEnrollmentStore 的 TS 模块——避免为此引入构建步骤。
 * 只生成码本身（不涉及哈希）；**码的字符集必须与那个模块保持一致**，改动时两边都要动。
 */
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 去掉 0/O、1/I/L

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of ['.env.local', '.env.production', '.env']) {
    try {
      const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='));
      if (line) return line.slice('DATABASE_URL='.length).trim();
    } catch { /* 文件不存在就继续试下一个 */ }
  }
  throw new Error('找不到 DATABASE_URL：请设置环境变量，或在项目根目录放 .env.local。');
}

function parseArgs(argv) {
  const out = { flags: {}, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out.flags[key] = next; i += 1; }
      else out.flags[key] = true;
    } else out.positional.push(a);
  }
  return out;
}

function generateCode(length = 8) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const client = new Client({ connectionString: loadDatabaseUrl() });
  await client.connect();

  try {
    if (flags.list) {
      const { rows } = await client.query(
        `select c.code, c.label, c.use_count, c.max_uses, c.expires_at, c.revoked_at,
                u.feishu_name as user_name, i.app_id
           from host_enrollment_codes c
           join feishu_integrations i on i.id = c.integration_id
           left join users u on u.id = i.user_id
          order by c.created_at desc limit 30`
      );
      if (rows.length === 0) { console.log('（还没有接入码）'); return; }
      console.log('接入码\tlabel\t已用/上限\t集成用户\t状态');
      for (const r of rows) {
        const state = r.revoked_at ? '已吊销'
          : (r.expires_at && new Date(r.expires_at) <= new Date()) ? '已过期'
          : r.use_count >= r.max_uses ? '次数用尽' : '可用';
        console.log(`${r.code}\t${r.label ?? '-'}\t${r.use_count}/${r.max_uses}\t${r.user_name ?? '-'}\t${state}`);
      }
      return;
    }

    if (flags.revoke) {
      const code = String(flags.revoke).trim().toUpperCase();
      const { rowCount } = await client.query(
        'update host_enrollment_codes set revoked_at = now() where code = $1 and revoked_at is null',
        [code]
      );
      console.log(rowCount ? `✅ 已吊销 ${code}` : `⚠️  没找到可吊销的 ${code}`);
      return;
    }

    const integrationId = flags.integration;
    if (!integrationId) {
      console.error('用法：node scripts/createHostEnrollmentCode.mjs --integration <集成ID> [--label 给谁用] [--max-uses 5] [--days 30]');
      process.exit(1);
    }

    const { rows: found } = await client.query(
      `select i.id, i.app_id, u.feishu_name
         from feishu_integrations i left join users u on u.id = i.user_id
        where i.id = $1 and i.deleted_at is null`,
      [integrationId]
    );
    if (found.length === 0) {
      console.error(`❌ 集成不存在或已删除：${integrationId}`);
      process.exit(1);
    }

    const maxUses = Number(flags['max-uses'] || 5);
    const days = flags.days ? Number(flags.days) : null;
    const label = typeof flags.label === 'string' ? flags.label : null;
    const expiresAt = days ? new Date(Date.now() + days * 24 * 3600 * 1000) : null;

    let code = generateCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { rowCount } = await client.query(
        `insert into host_enrollment_codes (code, integration_id, label, max_uses, expires_at)
         values ($1, $2, $3, $4, $5) on conflict (code) do nothing`,
        [code, integrationId, label, maxUses, expiresAt]
      );
      if (rowCount) break;
      code = generateCode();
    }

    console.log('');
    console.log('  接入码：' + code);
    console.log('  绑定集成：' + integrationId + '（' + (found[0].feishu_name ?? '未知用户') + ' / ' + found[0].app_id + '）');
    if (label) console.log('  备注：' + label);
    console.log(`  可用次数：${maxUses}${expiresAt ? '，有效期至 ' + expiresAt.toISOString().slice(0, 10) : '，长期有效'}`);
    console.log('');
    console.log('  把这个码发给用户，让他在宿主里执行：');
    console.log('    npx teaming-mcp setup --code ' + code);
    console.log('');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('❌', error.message);
  process.exit(1);
});
