import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, mocks = {}) {
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    console,
    Date,
    require(name) {
      if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
      return mocks[name];
    },
  });
  return exports;
}

const { shouldRefreshAuthorization, DEFAULT_REFRESH_WINDOW_MS } = load(
  'src/lib/feishu/integration/tokenRefreshSweeper.ts',
  {
    './integrationStore': {
      getLatestFeishuAuthorizationContext: async () => null,
      listActiveFeishuIntegrationContextsWithBase: async () => [],
      writeAuditLog: async () => {},
    },
    './tokenService': { getValidIntegrationUserAuthorization: async () => ({}) },
    '../common/monitor': { logFeishuMonitor() {}, toErrorContext: () => ({}) },
  }
);

const NOW = new Date('2026-10-13T12:00:00Z');
const days = (n) => n * 24 * 60 * 60 * 1000;

function auth(overrides = {}) {
  return {
    status: 'authorized',
    refreshToken: 'rt',
    refreshTokenExpiresAt: new Date(NOW.getTime() + days(7)),
    ...overrides,
  };
}

/**
 * 事故背景：refresh token 只有 7 天有效期，而续期此前完全依赖业务请求。
 * worker 停摆 13 天 → 刷新链断裂 → 授权集体过期。
 * 这些用例锁住"什么时候必须主动续期"。
 */

test('剩余 7 天（刚续期过）→ 不刷', () => {
  assert.equal(shouldRefreshAuthorization(auth(), { now: NOW }), false);
});

test('剩余 3 天（等于默认窗口）→ 刷', () => {
  assert.equal(
    shouldRefreshAuthorization(auth({ refreshTokenExpiresAt: new Date(NOW.getTime() + days(3)) }), {
      now: NOW,
    }),
    true
  );
});

test('剩余 1 天 → 刷', () => {
  assert.equal(
    shouldRefreshAuthorization(auth({ refreshTokenExpiresAt: new Date(NOW.getTime() + days(1)) }), {
      now: NOW,
    }),
    true
  );
});

test('已过期 → 仍要尝试刷（也许还能救回来）', () => {
  assert.equal(
    shouldRefreshAuthorization(auth({ refreshTokenExpiresAt: new Date(NOW.getTime() - days(1)) }), {
      now: NOW,
    }),
    true
  );
});

test('到期时间未知 → 保守刷新', () => {
  assert.equal(
    shouldRefreshAuthorization(auth({ refreshTokenExpiresAt: null }), { now: NOW }),
    true
  );
});

test('非 authorized 状态 → 不刷（交给重新授权提醒链路）', () => {
  for (const status of ['reauthorization_required', 'revoked', 'pending']) {
    assert.equal(
      shouldRefreshAuthorization(auth({ status }), { now: NOW }),
      false,
      `状态 ${status} 不应触发刷新`
    );
  }
});

test('没有 refresh token → 刷不了', () => {
  assert.equal(shouldRefreshAuthorization(auth({ refreshToken: null }), { now: NOW }), false);
});

test('窗口可配置', () => {
  const almostFresh = auth({ refreshTokenExpiresAt: new Date(NOW.getTime() + days(5)) });
  assert.equal(shouldRefreshAuthorization(almostFresh, { now: NOW }), false);
  assert.equal(
    shouldRefreshAuthorization(almostFresh, { now: NOW, windowMs: days(6) }),
    true,
    '窗口放大到 6 天时，剩 5 天的应当刷新'
  );
});

test('默认窗口是 3 天——必须明显小于 7 天有效期，留足重试余地', () => {
  assert.equal(DEFAULT_REFRESH_WINDOW_MS, 3 * 24 * 60 * 60 * 1000);
  assert.ok(
    DEFAULT_REFRESH_WINDOW_MS < 7 * 24 * 60 * 60 * 1000,
    '窗口必须小于 refresh token 有效期'
  );
});
