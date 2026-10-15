#!/usr/bin/env node
/**
 * 给一个「只用宿主通道」的用户开通账号 + 集成 + 接入码。
 *
 * ## 为什么需要这个脚本
 *
 * 宿主通道（MCP / Skill / curl）**不需要飞书自建应用**——用户用自己的豆包账号
 * 能力取妙记，我们的服务只做分析。但 `feishu_integrations` 表要求
 * `app_id` / `app_secret_encrypted` 非空（那是网页版流程建的集成必须有的）。
 *
 * 与其把这两个字段改成可空（会牵动 19 个文件的类型），不如**填占位值**，
 * 并用一个天然的隔离开关把它挡在网页版链路之外：
 *
 *   `selected_org_target_id = NULL`
 *
 * 网页版链路、事件监听、token 刷新、投递健康检查，全都通过
 * `listActiveFeishuIntegrationContextsWithBase()` 取集成，而那个函数
 * **要求 `selected_org_target_id IS NOT NULL`**。所以不设它就等于不进入任何
 * 飞书链路——不会去订阅事件、不会去刷新 token、不会去调飞书 API。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/onboardHostUser.mjs --name "张三" [--email z@x.com] [--max-uses 5] [--days 90]
 * node scripts/onboardHostUser.mjs --list
 * ```
 *
 * 输出接入码，把它给用户，让他在宿主里填一次即可。
 */
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const ROOT = process.cwd();

/** 占位 app_id：一眼能看出这是宿主通道的集成，不是真的飞书应用 */
export const HOST_APP_ID = 'host-channel-no-feishu-app';

/** 供测试直接调用，验证密文能被真实 decrypt 解开 */
export const __test__ = { encryptSecret, HOST_APP_ID };

function loadEnv() {
  // 复用 .env.local（与其它脚本一致）
  for (const f of ['.env.local', '.env.production']) {
    try {
      const raw = readFileSync(path.join(ROOT, f), 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    } catch {
      // 文件不存在就跳过
    }
  }
}

/**
 * 生成接入码：8 位、去掉易混淆字符（0/O、1/I/L）。
 * 与 createHostEnrollmentCode.mjs 保持同样的字符集与长度。
 */
function generateCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * 复刻 src/lib/security/crypto.ts 的 encrypt()。
 *
 * **必须逐字对齐**：这个脚本是 .mjs，import 不了 TS 模块，只能复刻。
 * 任何一处不同（版本号、base64 vs base64url、密钥来源）都会让宿主通道
 * 读集成时 decrypt() 抛错。tests/host-onboard-script.test.mjs 守着这一点：
 * 它用真实的 decrypt 逻辑解开本函数产出的密文。
 *
 * 对应关系：
 *   ENCRYPTION_VERSION = 'enc-v1'
 *   密钥 = sha256(APP_ENCRYPTION_KEY)（注意不是 ENCRYPTION_KEY）
 *   IV 12 字节，格式 <version>:<iv>:<tag>:<ciphertext>，三段都是 base64url
 */
const ENCRYPTION_VERSION = 'enc-v1';
const IV_LENGTH = 12;

function encryptSecret(plain) {
  const keyRaw = process.env.APP_ENCRYPTION_KEY;
  if (!keyRaw) throw new Error('缺少 APP_ENCRYPTION_KEY，无法加密占位密钥');
  const key = createHash('sha256').update(keyRaw).digest();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    }
  }
  return flags;
}

async function main() {
  loadEnv();
  const flags = parseArgs(process.argv);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    if (flags.list) {
      const { rows } = await client.query(`
        select u.feishu_name as 用户,
               coalesce(u.feishu_email, '(无)') as 邮箱,
               left(i.id::text, 8) as 集成,
               coalesce(p.name, '(无)') as 项目,
               c.code as 接入码,
               c.use_count || '/' || c.max_uses as 用量,
               case when c.revoked_at is null then '有效' else '已吊销' end as 状态
        from feishu_integrations i
        join users u on u.id = i.user_id
        left join feishu_projects p on p.id = i.project_id
        left join host_enrollment_codes c on c.integration_id = i.id
        where i.app_id = $1
        order by i.created_at desc
      `, [HOST_APP_ID]);
      if (!rows.length) {
        console.log('  还没有宿主通道用户。用 --name "姓名" 开通一个。');
      } else {
        for (const r of rows) {
          console.log(`  ${r.用户}  ${r.邮箱}  集成=${r.集成}  项目=${r.项目}  码=${r.接入码 ?? '(无)'}  ${r.用量 ?? ''}  ${r.状态 ?? ''}`);
        }
      }
      return;
    }

    const name = typeof flags.name === 'string' ? flags.name.trim() : '';
    if (!name) {
      console.error('用法：node scripts/onboardHostUser.mjs --name "姓名" [--email x@y.com] [--max-uses 5] [--days 90]');
      console.error('      node scripts/onboardHostUser.mjs --list');
      process.exit(1);
    }

    const email = typeof flags.email === 'string' ? flags.email.trim() : null;
    const maxUses = Number(flags['max-uses'] || 5);
    const days = Number(flags.days || 90);
    const projectId = typeof flags.project === 'string' ? flags.project : null;

    // ── 1) 用户：按姓名+邮箱复用，否则新建 ──
    let userId;
    const found = await client.query(
      `select id from users where feishu_name = $1 ${email ? 'and feishu_email = $2' : ''} limit 1`,
      email ? [name, email] : [name],
    );
    if (found.rows.length) {
      userId = found.rows[0].id;
      console.log(`  复用已有用户 ${name}`);
    } else {
      // 宿主通道用户没有飞书 open_id，用稳定占位值占住唯一索引
      const openId = `host-user-${randomUUID()}`;
      const ins = await client.query(
        `insert into users (feishu_open_id, feishu_name, feishu_email)
         values ($1, $2, $3) returning id`,
        [openId, name, email],
      );
      userId = ins.rows[0].id;
      console.log(`  新建用户 ${name}`);
    }

    // ── 2) 集成：占位凭证 + 不设 selected_org_target_id（隔离）──
    // 先看这个用户是不是已经有宿主集成了——重跑脚本不该重复建
    const existingHost = await client.query(
      `select id from feishu_integrations
       where user_id = $1 and app_id = $2 and deleted_at is null
       order by created_at desc limit 1`,
      [userId, HOST_APP_ID],
    );

    const project = projectId
      ? projectId
      : (await client.query(`select id from feishu_projects where status = 'active' limit 1`)).rows[0]?.id ?? null;

    let integrationId;
    if (existingHost.rows.length) {
      integrationId = existingHost.rows[0].id;
      console.log(`  复用已有宿主集成 ${integrationId.slice(0, 8)}（不重复建）`);
    } else {
    const insIntegration = await client.query(
      `insert into feishu_integrations (
         user_id, name, status, setup_step,
         app_id, app_secret_encrypted, oauth_scope,
         required_events, required_permissions,
         is_active, activated_at, project_id, initialized_at, first_initialized_at
       ) values (
         $1, $2, 'success', 'host_channel',
         $3, $4, '',
         '[]'::jsonb, '[]'::jsonb,
         true, now(), $5, now(), now()
       ) returning id, created_at`,
      [
        userId,
        `宿主通道-${name}`,
        HOST_APP_ID,
        encryptSecret(randomBytes(32).toString('hex')),
        project,
      ],
    );
    integrationId = insIntegration.rows[0].id;
    console.log(`  集成已建 ${integrationId.slice(0, 8)}（project=${project ? project.slice(0, 8) : '(无)'}）`);
    }

    // ── 3) 接入码 ──
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    let code = generateCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const dup = await client.query('select 1 from host_enrollment_codes where code = $1', [code]);
      if (!dup.rows.length) break;
      code = generateCode();
    }
    await client.query(
      `insert into host_enrollment_codes (code, integration_id, label, max_uses, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [code, integrationId, `宿主通道-${name}`, maxUses, expiresAt],
    );

    // ── 4) 审计（表名是 feishu_audit_logs；summary 是 NOT NULL，metadata 是 jsonb）──
    await client.query(
      `insert into feishu_audit_logs (user_id, integration_id, action, result, summary, metadata)
       values ($1, $2, 'host_user.onboarded', 'success', $3, $4::jsonb)`,
      [
        userId,
        integrationId,
        `宿主通道用户开通：${name}（可用 ${maxUses} 次，${days} 天）`,
        JSON.stringify({ name, email, maxUses, days }),
      ],
    );

    console.log('');
    console.log('  ┌─────────────────────────────────────────────');
    console.log(`  │  用户：    ${name}${email ? ` (${email})` : ''}`);
    console.log(`  │  集成：    ${integrationId}`);
    console.log(`  │  接入码：  ${code}`);
    console.log(`  │  可用：    ${maxUses} 次，有效期至 ${expiresAt.toISOString().slice(0, 10)}`);
    console.log('  └─────────────────────────────────────────────');
    console.log('');
    console.log('  把接入码给用户，让他在宿主里填一次即可。');
    console.log('  （宿主通道集成不进入飞书链路：不订阅事件、不刷新 token、不调飞书 API）');
  } finally {
    await client.end();
  }
}

// 只在【直接运行】时执行；被测试 import 时不要连数据库
const isDirectRun = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`  失败：${error.message}`);
    process.exit(1);
  });
}
