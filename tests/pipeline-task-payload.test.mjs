import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(path) {
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, console });
  return exports;
}

const {
  asRecord,
  asString,
  getTargetFromPayload,
  getEventReceivedAtFromPayload,
  isNotificationSuppressedFromPayload,
} = load('src/lib/feishu/pipeline/pipelineTaskPayload.ts');

/**
 * 补数抑制链路：只有 payload 里出现抑制标记，通知任务才会以 cancelled 入队。
 * 这里锁住"SQL 写进去的 JSON"与"代码读出来的结果"完全对得上。
 */

test('SQL 脚本写出的 JSON 形状能被正确识别', () => {
  // 这正是 2026-10-13_suppress_backlog_notifications.sql 里 jsonb_build_object 的结果
  const payload = {
    telemetry: { eventReceivedAt: '2026-10-05T14:17:36.001Z' },
    target: { orgTargetId: 'abc', projectId: 'p1' },
    delivery: { suppressNotification: true },
  };
  assert.equal(isNotificationSuppressedFromPayload(payload), true);
});

test('没有标记时不会抑制（正常会议照常推卡片）', () => {
  assert.equal(isNotificationSuppressedFromPayload({}), false);
  assert.equal(
    isNotificationSuppressedFromPayload({ telemetry: { eventReceivedAt: 'x' } }),
    false
  );
  assert.equal(isNotificationSuppressedFromPayload({ delivery: {} }), false);
});

test('字符串 "true" 不算数——防止 SQL 手写成字符串导致误判', () => {
  assert.equal(
    isNotificationSuppressedFromPayload({ delivery: { suppressNotification: 'true' } }),
    false
  );
  assert.equal(
    isNotificationSuppressedFromPayload({ delivery: { suppressNotification: 1 } }),
    false
  );
});

test('标记只在 delivery 层生效，不受其他字段干扰', () => {
  assert.equal(
    isNotificationSuppressedFromPayload({ suppressNotification: true }),
    false,
    '顶层同名键不应生效'
  );
  assert.equal(
    isNotificationSuppressedFromPayload({
      delivery: { suppressNotification: true, other: 'x' },
      target: { orgTargetId: 'z' },
    }),
    true
  );
});

test('payload 为空或异常时不抛错', () => {
  assert.equal(isNotificationSuppressedFromPayload({}), false);
  assert.equal(isNotificationSuppressedFromPayload({ delivery: null }), false);
  assert.equal(isNotificationSuppressedFromPayload({ delivery: 'x' }), false);
});

test('组织目标与事件时间仍能正常读取（回归）', () => {
  const payload = {
    target: { projectId: 'p1', orgTargetId: 'org-1', orgKey: 'k' },
    telemetry: { eventReceivedAt: '2026-09-30T14:50:31.299Z' },
    delivery: { suppressNotification: true },
  };
  assert.equal(getTargetFromPayload(payload), 'org-1');
  assert.equal(getEventReceivedAtFromPayload(payload), '2026-09-30T14:50:31.299Z');
  // 抑制标记不应破坏其他字段的读取
  assert.equal(isNotificationSuppressedFromPayload(payload), true);
});

test('asRecord 对非对象返回空对象，asString 对空白返回 undefined', () => {
  // 跨 VM realm 的对象原型不同，用键值判断而不是深比较
  assert.equal(Object.keys(asRecord(null)).length, 0);
  assert.equal(Object.keys(asRecord('x')).length, 0);
  assert.equal(asRecord({ a: 1 }).a, 1);
  assert.equal(asString('  hi  '), 'hi');
  assert.equal(asString('   '), undefined);
  assert.equal(asString(123), undefined);
});
