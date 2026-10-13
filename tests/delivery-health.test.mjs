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

const {
  classifyDeliveryHealth,
  buildDeliveryHealthAlert,
  DEFAULT_EXPIRING_SOON_DAYS,
  DEFAULT_QUIET_DAYS,
} = load(
  'src/lib/feishu/integration/integrationDeliveryHealth.ts',
  {
    '@/lib/db/client': { getDb: () => ({}) },
    '@/lib/db/schema': {},
    'drizzle-orm': { sql: () => ({}) },
    './integrationStore': {
      getLatestFeishuAuthorizationContext: async () => null,
      listActiveFeishuIntegrationContextsWithBase: async () => [],
      writeAuditLog: async () => {},
    },
    '../common/monitor': { logFeishuMonitor() {}, toErrorContext: () => ({}) },
    '../ops/opsAlertService': { sendOpsAlert: async () => ({ sent: false, reason: 'test' }) },
  }
);

const NOW = new Date('2026-10-13T12:00:00Z');
const days = (n) => n * 24 * 60 * 60 * 1000;

function verdict(overrides = {}) {
  return classifyDeliveryHealth({
    authorizationStatus: 'authorized',
    refreshTokenExpiresAt: new Date(NOW.getTime() + days(7)),
    daysSinceLastEvent: 1,
    now: NOW,
    ...overrides,
  });
}

/**
 * 飞书 2026-10-26 变更：未授权 / 不在可用范围的用户，事件不再投递且无法补发。
 * 这些用例锁住"什么情况必须告警"。
 */

test('授权有效 + 令牌充足 + 近期有事件 → ok', () => {
  const r = verdict();
  assert.equal(r.level, 'ok');
  assert.equal(r.reasonCode, 'healthy');
});

test('没有授权记录 → error（10-26 起事件不会再投递）', () => {
  const r = verdict({ authorizationStatus: null });
  assert.equal(r.level, 'error');
  assert.equal(r.reasonCode, 'authorization_missing');
  assert.match(r.message, /不再投递/);
});

test('授权非 authorized → error，且带上状态', () => {
  const r = verdict({ authorizationStatus: 'reauthorization_required' });
  assert.equal(r.level, 'error');
  assert.equal(r.reasonCode, 'authorization_invalid');
  assert.match(r.message, /reauthorization_required/);
});

test('Refresh Token 已过期 → error', () => {
  const r = verdict({ refreshTokenExpiresAt: new Date(NOW.getTime() - days(1)) });
  assert.equal(r.level, 'error');
  assert.equal(r.reasonCode, 'refresh_token_expired');
});

test('Refresh Token 即将到期 → warn', () => {
  const r = verdict({ refreshTokenExpiresAt: new Date(NOW.getTime() + days(2)) });
  assert.equal(r.level, 'warn');
  assert.equal(r.reasonCode, 'refresh_token_expiring_soon');
});

test('从未收到过事件 → warn', () => {
  const r = verdict({ daysSinceLastEvent: null });
  assert.equal(r.level, 'warn');
  assert.equal(r.reasonCode, 'no_event_ever');
});

test('长时间没有事件 → warn，且说明可能只是没开会', () => {
  const r = verdict({ daysSinceLastEvent: 10 });
  assert.equal(r.level, 'warn');
  assert.equal(r.reasonCode, 'no_event_for_a_while');
  assert.match(r.message, /可忽略/);
});

test('授权问题优先级高于"没有事件"', () => {
  const r = verdict({ authorizationStatus: 'reauthorization_required', daysSinceLastEvent: 30 });
  assert.equal(r.level, 'error');
  assert.equal(r.reasonCode, 'authorization_invalid');
});

test('默认阈值：令牌窗口 3 天、静默 7 天', () => {
  assert.equal(DEFAULT_EXPIRING_SOON_DAYS, 3);
  assert.equal(DEFAULT_QUIET_DAYS, 7);
});

test('阈值可配置', () => {
  const soon = classifyDeliveryHealth({
    authorizationStatus: 'authorized',
    refreshTokenExpiresAt: new Date(NOW.getTime() + days(5)),
    daysSinceLastEvent: 1,
    now: NOW,
    expiringSoonDays: 6,
  });
  assert.equal(soon.level, 'warn');

  const quiet = classifyDeliveryHealth({
    authorizationStatus: 'authorized',
    refreshTokenExpiresAt: new Date(NOW.getTime() + days(7)),
    daysSinceLastEvent: 3,
    now: NOW,
    quietDays: 2,
  });
  assert.equal(quiet.level, 'warn');
  assert.equal(quiet.reasonCode, 'no_event_for_a_while');
});

// ─────────── 告警内容（A+C 方案的 A 层） ───────────

function summary(overrides = {}) {
  return {
    scanned: 28,
    ok: 4,
    warn: 1,
    error: 23,
    warnings: [],
    durationMs: 100,
    ...overrides,
  };
}

test('无异常时不发告警（不发无意义消息）', () => {
  assert.equal(buildDeliveryHealthAlert(summary({ ok: 28, warn: 0, error: 0 })), null);
});

test('有异常时生成告警，含计数与分组', () => {
  const alert = buildDeliveryHealthAlert(
    summary({
      warnings: [
        { integrationId: 'a', level: 'error', reasonCode: 'authorization_invalid' },
        { integrationId: 'b', level: 'error', reasonCode: 'authorization_invalid' },
        { integrationId: 'c', level: 'warn', reasonCode: 'no_event_ever' },
      ],
      error: 2,
      warn: 1,
    })
  );
  assert.ok(alert);
  assert.match(alert.title, /异常/);
  assert.match(alert.markdown, /authorization_invalid\*\* × 2/);
  assert.match(alert.markdown, /no_event_ever\*\* × 1/);
  assert.match(alert.markdown, /异常 2/);
});

test('告警必须带「该怎么办」，不能只报错', () => {
  const alert = buildDeliveryHealthAlert(
    summary({
      warnings: [{ integrationId: 'a', level: 'error', reasonCode: 'authorization_invalid' }],
      error: 1,
      warn: 0,
    })
  );
  assert.ok(alert);
  assert.match(alert.markdown, /需用户重新授权/);
  assert.match(alert.markdown, /可用范围/, '要告诉人去配可用范围');
});

test('告警里说明 10-26 变更的紧迫性', () => {
  const alert = buildDeliveryHealthAlert(
    summary({ warnings: [{ integrationId: 'a', level: 'error', reasonCode: 'authorization_invalid' }], error: 1, warn: 0 })
  );
  assert.ok(alert);
  assert.match(alert.markdown, /2026-10-26/);
  assert.match(alert.markdown, /无法补发/);
});

test('未知 reasonCode 也不会崩（只是没有指引）', () => {
  const alert = buildDeliveryHealthAlert(
    summary({ warnings: [{ integrationId: 'a', level: 'error', reasonCode: 'brand_new_code' }], error: 1, warn: 0 })
  );
  assert.ok(alert);
  assert.match(alert.markdown, /brand_new_code/);
});
