import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

/**
 * 应用凭证实时校验的测试。
 *
 * 背景：`app_credential_status` 原先只在建应用时写一次，导致
 * "数据库说正常、实际 21001" 的误判。这个模块负责把它变成实时状态。
 */

function load(relativePath, mocks) {
  const filename = path.resolve(relativePath);
  const source = readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;

  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    require(name) {
      if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
      return mocks[name];
    },
    console,
    // 动态读取，便于测试替换 globalThis.fetch
    get fetch() {
      return globalThis.fetch;
    },
    AbortSignal: globalThis.AbortSignal,
    JSON,
    Date,
    Error,
    Promise,
  };
  vm.runInNewContext(compiled, context, { filename });
  return module.exports;
}

const {
  classifyAppCredentialProbe,
  probeIntegrationAppCredential,
} = load('src/lib/feishu/integration/appCredentialProbe.ts', {
  '../common/monitor': { logFeishuMonitor() {}, toErrorContext: () => ({}) },
});

// ─────────── 纯函数：返回码映射 ───────────

test('code=0 判定为正常', () => {
  assert.equal(classifyAppCredentialProbe(0, 'ok').status, 'success');
});

test('code=21001 判定为失败（管控策略拒绝——豆包账号即此码）', () => {
  const r = classifyAppCredentialProbe(21001, 'Access denied by access control policy.');
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, '21001');
});

test('code=10014 判定为失败（密钥无效/应用不存在）', () => {
  const r = classifyAppCredentialProbe(10014, 'app secret invalid');
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, '10014');
});

test('code=10217 判定为失败（应用已删除）', () => {
  const r = classifyAppCredentialProbe(10217, 'app has been deleted');
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, '10217');
});

test('未知返回码也判失败，并保留原始码便于排查', () => {
  const r = classifyAppCredentialProbe(99999, 'something new');
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, '99999');
});

// ─────────── 真实校验：靠 fetch 的行为 ───────────

const integration = { id: 'i-1', appId: 'cli_x', secrets: { appSecret: 's' } };

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('飞书返回 code=0 → success', async () => {
  const r = await withFetch(
    async () => ({ json: async () => ({ code: 0, msg: 'ok' }) }),
    () => probeIntegrationAppCredential(integration)
  );
  assert.equal(r.status, 'success');
});

test('飞书返回 21001 → failed（这就是那 12 个应用的情况）', async () => {
  const r = await withFetch(
    async () => ({ json: async () => ({ code: 21001, msg: 'Access denied by access control policy.' }) }),
    () => probeIntegrationAppCredential(integration)
  );
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, '21001');
});

test('网络异常 → unknown（不能据此把应用判死）', async () => {
  const r = await withFetch(
    async () => {
      throw new Error('ETIMEDOUT');
    },
    () => probeIntegrationAppCredential(integration)
  );
  assert.equal(r.status, 'unknown');
  assert.equal(r.errorCode, 'probe_errored');
});

test('密钥缺失 → failed，且不发请求', async () => {
  let called = false;
  const r = await withFetch(
    async () => {
      called = true;
      return { json: async () => ({ code: 0 }) };
    },
    () => probeIntegrationAppCredential({ id: 'i-2', appId: 'cli_y', secrets: {} })
  );
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'secret_missing');
  assert.equal(called, false, '密钥缺失时不应发出请求');
});

test('每次都真实取 token（不依赖缓存）', async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return { json: async () => ({ code: 0, msg: 'ok' }) };
    },
    async () => {
      await probeIntegrationAppCredential(integration);
      await probeIntegrationAppCredential(integration);
    }
  );
  assert.equal(calls, 2, '两次校验应发出两次真实请求');
});

test('请求体只含 app_id / app_secret，不外泄其他字段', async () => {
  let body = null;
  await withFetch(
    async (_url, init) => {
      body = JSON.parse(init.body);
      return { json: async () => ({ code: 0 }) };
    },
    () => probeIntegrationAppCredential(integration)
  );
  assert.deepEqual(Object.keys(body).sort(), ['app_id', 'app_secret']);
});
