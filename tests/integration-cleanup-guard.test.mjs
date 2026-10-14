import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

/**
 * 回归测试：2026-10-14 数据损坏事故。
 *
 * 事故链：
 *   授权过期 → 监听启动失败 → 集成被写成 status='draft' + initializedAt=null
 *   → 与"从未初始化过的废弃集成"无法区分
 *   → 被 sweepStaleFeishuIntegrations 按 6 小时 TTL 软删除
 *
 * 被删的 22 个集成**全部曾成功初始化过、全部有授权**。
 */

function load(relativePath, mocks) {
  const filename = path.resolve(relativePath);
  const source = readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
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
    Date,
    Error,
    JSON,
    Promise,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
  };
  vm.runInNewContext(compiled, context, { filename });
  return module.exports;
}

const drizzleStub = {
  and: (...a) => a,
  desc: (x) => x,
  eq: (a, b) => ({ a, b }),
  gt: (a, b) => ({ a, b }),
  inArray: (a, b) => ({ a, b }),
  isNotNull: (x) => x,
  isNull: (x) => x,
  lt: (a, b) => ({ a, b }),
  sql: (s) => s,
};

const { isStaleIncompleteCandidate } = load(
  'src/lib/feishu/integration/integrationStore.ts',
  {
    'drizzle-orm': drizzleStub,
    '@/lib/db/client': { getDb: () => ({}) },
    '@/lib/db/schema': {},
    '@/lib/platform/env': { getDefaultFeishuOauthScope: () => '' },
    './integrationConstants': { FEISHU_REQUIRED_USER_EVENTS: [], FEISHU_REQUIRED_USER_SCOPES: [] },
    '@/lib/security/crypto': {
      createOpaqueToken: () => 'x',
      decrypt: (v) => v,
      encrypt: (v) => v,
      hashForLookup: (v) => v,
      maskSecret: (v) => v,
    },
  }
);

const HOUR = 60 * 60 * 1000;
const cutoff = new Date('2026-10-14T06:00:00Z');

function candidate(overrides = {}) {
  return {
    deletedAt: null,
    initializedAt: null,
    firstInitializedAt: null,
    status: 'draft',
    updatedAt: new Date(cutoff.getTime() - HOUR),
    cutoff,
    ...overrides,
  };
}

test('从未初始化过、超期、draft → 可清理（原有行为不变）', () => {
  assert.equal(isStaleIncompleteCandidate(candidate()), true);
});

test('★ 曾成功初始化过的集成【永不】被清理 —— 事故根因防线', () => {
  // 这正是那 22 个集成的样子：initializedAt 被清空，但 firstInitializedAt 还在
  assert.equal(
    isStaleIncompleteCandidate(candidate({ firstInitializedAt: new Date('2026-09-28T13:00:00Z') })),
    false
  );
});

test('仍有 initializedAt 的集成不被清理', () => {
  assert.equal(
    isStaleIncompleteCandidate(candidate({ initializedAt: new Date('2026-10-13T00:00:00Z') })),
    false
  );
});

test('已删除的不重复处理', () => {
  assert.equal(isStaleIncompleteCandidate(candidate({ deletedAt: new Date() })), false);
});

test('已就绪（非 draft）的集成不被清理', () => {
  assert.equal(isStaleIncompleteCandidate(candidate({ status: 'success' })), false);
});

test('未超期的集成不被清理（6 小时 TTL 尚在保护期内）', () => {
  assert.equal(
    isStaleIncompleteCandidate(candidate({ updatedAt: new Date(cutoff.getTime() + HOUR) })),
    false
  );
});

test('TTL 边界：恰好早于 cutoff 才可清理', () => {
  assert.equal(isStaleIncompleteCandidate(candidate({ updatedAt: cutoff })), false);
  assert.equal(
    isStaleIncompleteCandidate(candidate({ updatedAt: new Date(cutoff.getTime() - 1) })),
    true
  );
});

// ─────────── 根因：监听失败不得清空 initializedAt ───────────

test('★ 监听启动失败路径不再写 initializedAt: null', () => {
  const source = readFileSync(
    path.resolve('src/lib/feishu/events/eventListenerManager.ts'),
    'utf8'
  );
  // 定位失败分支里的 updateUserFeishuIntegration 调用
  const idx = source.indexOf("event_listener_start_skipped");
  assert.ok(idx > 0, '应存在 event_listener_start_skipped 分支');
  const block = source.slice(Math.max(0, idx - 1200), idx);
  const call = block.slice(block.lastIndexOf('updateUserFeishuIntegration'));
  assert.ok(call.length > 0, '失败分支应有 updateUserFeishuIntegration 调用');
  assert.ok(
    !/initializedAt\s*:\s*null/.test(call),
    '失败分支不得清空 initializedAt —— 这是 2026-10-14 数据损坏的根因'
  );
});
