import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, mocks = {}, extra = {}) {
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    Date,
    console,
    JSON,
    require(name) {
      if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
      return mocks[name];
    },
    ...extra,
  });
  return exports;
}

const { resolveInitialNotificationState } = load(
  'src/lib/feishu/delivery/notificationTaskStore.ts',
  {
    '@/lib/db/client': { getDb: () => ({}) },
    '@/lib/db/schema': {},
    'drizzle-orm': { sql: () => ({}), eq: () => ({}) },
    './deliveryTaskStore': {},
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  }
);

/** 数据库 CHECK 约束允许的取值（meeting_report_notification_tasks_status_chk） */
const ALLOWED_STATUSES = [
  'pending',
  'running',
  'retry_wait',
  'succeeded',
  'blocked',
  'unknown',
  'cancelled',
];

test('默认情况：正常待发', () => {
  const state = resolveInitialNotificationState({});
  assert.equal(state.status, 'pending');
  assert.equal(state.errorCode, null);
  assert.equal(state.errorSummary, null);
});

test('抑制推送：记为 cancelled（留痕但不发送）', () => {
  const state = resolveInitialNotificationState({ suppressed: true });
  assert.equal(state.status, 'cancelled');
  assert.match(state.errorSummary, /改回 pending/);
});

test('接收人问题优先于抑制：仍记为 blocked', () => {
  const state = resolveInitialNotificationState({
    blockedReason: 'RECIPIENT_MISSING',
    suppressed: true,
  });
  assert.equal(state.status, 'blocked');
  assert.equal(state.errorCode, 'RECIPIENT_MISSING');
});

test('产生的状态必须落在数据库 CHECK 允许的取值内', () => {
  const cases = [
    {},
    { suppressed: true },
    { blockedReason: 'RECIPIENT_MISSING' },
    { blockedReason: 'RECIPIENT_MISMATCH', suppressed: true },
  ];
  for (const input of cases) {
    const { status } = resolveInitialNotificationState(input);
    assert.ok(
      ALLOWED_STATUSES.includes(status),
      `状态 ${status} 不在 CHECK 约束允许范围内，写入会失败`
    );
  }
});

test('cancelled 不在 worker 的领取范围内（不会被发送）', () => {
  // 交付 worker 的领取条件是 status in ('pending','retry_wait')
  const claimable = ['pending', 'retry_wait'];
  const { status } = resolveInitialNotificationState({ suppressed: true });
  assert.ok(!claimable.includes(status), 'cancelled 不应被交付 worker 领取');
});
