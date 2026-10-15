/**
 * 宿主用户开通脚本。
 *
 * 这个脚本是 .mjs，而加密实现在 TS 里，所以它**复刻**了一份 `encrypt()`。
 * 复刻最容易出的错是"看起来对、其实解不开"——版本号差一点、base64 写成
 * base64url 的反面、密钥来源搞错，都会让宿主通道读集成时 `decrypt()` 抛错，
 * 而报错现场离这里很远（表现为"集成不存在"或 500）。
 *
 * 所以这里的核心不是"测脚本能跑"，而是：
 *
 *   ① ★ 脚本加密的密文，必须能被 **项目真实的 decrypt()** 解开
 *   ② 占位 app_id 与真实飞书应用可区分
 *   ③ 脚本被 import 时不能连数据库（否则测试会碰到生产库）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const CRYPTO_PATH = 'src/lib/security/crypto.ts';
const SCRIPT_PATH = path.resolve('scripts/onboardHostUser.mjs');
const TEST_KEY = 'test-encryption-key-for-unit-test-only';

/** 用真实的 crypto.ts 造一个 decrypt()，密钥由我们注入 */
function loadRealCrypto(encryptionKey) {
  const code = ts.transpileModule(fs.readFileSync(CRYPTO_PATH, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const exportsObj = {};
  vm.runInNewContext(code, {
    exports: exportsObj,
    require(name) {
      if (name === 'node:crypto') return crypto;
      if (name === '@/lib/platform/env') {
        return { getAppEncryptionKey: () => encryptionKey };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
    Buffer,
    console,
    Error,
  });
  return exportsObj;
}

test('★ 脚本加密的密文能被项目真实的 decrypt() 解开', async () => {
  process.env.APP_ENCRYPTION_KEY = TEST_KEY;
  const script = await import(pathToFileURL(SCRIPT_PATH).href);
  const { encryptSecret } = script.__test__;
  const real = loadRealCrypto(TEST_KEY);

  const plain = 'placeholder-secret-0123456789abcdef';
  const payload = encryptSecret(plain);

  assert.equal(
    real.decrypt(payload),
    plain,
    '复刻的 encrypt 与真实 decrypt 必须兼容——否则宿主通道读集成时解密会失败',
  );
});

test('密文格式与项目一致：enc-v1 + 三段 base64url', async () => {
  process.env.APP_ENCRYPTION_KEY = TEST_KEY;
  const script = await import(pathToFileURL(SCRIPT_PATH).href);
  const payload = script.__test__.encryptSecret('x');

  const parts = payload.split(':');
  assert.equal(parts.length, 4, '格式应是 <version>:<iv>:<tag>:<ciphertext>');
  assert.equal(parts[0], 'enc-v1', "版本号必须是 'enc-v1'（不是 'v1'）");
  // base64url 不含 + / =
  for (const seg of parts.slice(1)) {
    assert.ok(!/[+/=]/.test(seg), `分段应是 base64url，实际含 base64 字符：${seg.slice(0, 20)}`);
  }
});

test('密钥来源是 APP_ENCRYPTION_KEY（不是 ENCRYPTION_KEY）', async () => {
  process.env.APP_ENCRYPTION_KEY = TEST_KEY;
  const script = await import(pathToFileURL(SCRIPT_PATH).href);
  const { encryptSecret } = script.__test__;

  // 用错的变量名推导出的密钥解不开
  const wrongKey = loadRealCrypto('a-totally-different-key');
  const payload = encryptSecret('x');
  assert.throws(
    () => wrongKey.decrypt(payload),
    '用错误的密钥必须解不开——说明密钥来源确实是 APP_ENCRYPTION_KEY',
  );
});

test('缺少 APP_ENCRYPTION_KEY 时明确报错，不静默产出坏密文', async () => {
  const script = await import(pathToFileURL(SCRIPT_PATH).href);
  const saved = process.env.APP_ENCRYPTION_KEY;
  delete process.env.APP_ENCRYPTION_KEY;
  try {
    assert.throws(() => script.__test__.encryptSecret('x'), /APP_ENCRYPTION_KEY/);
  } finally {
    process.env.APP_ENCRYPTION_KEY = saved;
  }
});

test('占位 app_id 一眼能看出不是真实飞书应用', async () => {
  const script = await import(pathToFileURL(SCRIPT_PATH).href);
  assert.equal(script.HOST_APP_ID, 'host-channel-no-feishu-app');
  assert.ok(
    !/^cli_/.test(script.HOST_APP_ID),
    '飞书自建应用的 app_id 形如 cli_xxx；占位值不能用这种前缀，否则会被误认为真应用',
  );
});

test('脚本源码里不设 selected_org_target_id（这是隔离机制）', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const insert = src.slice(src.indexOf('insert into feishu_integrations'), src.indexOf('returning id, created_at'));
  assert.ok(
    !insert.includes('selected_org_target_id'),
    '宿主集成绝不能设 selected_org_target_id——'
      + '网页版链路、事件监听、token 刷新都靠它筛集成；设了就会被卷进飞书链路',
  );
});

test('脚本引用的表名都能在 schema.ts 里找到', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const schema = fs.readFileSync('src/lib/db/schema.ts', 'utf8');

  // 抓 SQL 里的 from/into/join 目标
  const tables = new Set();
  for (const m of src.matchAll(/\b(?:from|into|join)\s+([a-z_][a-z0-9_]*)/gi)) {
    tables.add(m[1]);
  }
  assert.ok(tables.size > 0, '应该能抓到表名');

  const missing = [];
  for (const t of tables) {
    // schema.ts 里用 pgTable('<表名>', …) 声明
    if (!schema.includes(`'${t}'`) && !schema.includes(`"${t}"`)) missing.push(t);
  }
  assert.deepEqual(
    missing,
    [],
    `脚本引用了不存在的表：${missing.join(', ')}——`
      + '真机上会以 relation does not exist 失败，而那里离脚本很远（第一版就踩过 audit_logs）',
  );
});
