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
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    require(name) {
      if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
      return mocks[name];
    },
    ...extra,
  });
  return exports;
}

const { createResilientPoller } = load('src/lib/platform/resilientPoller.ts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 回归测试：2026-09-30 生产事故
 *
 * 旧的 worker 把重新排程写在 `finally` 里。一旦 await 永不 settle，
 * `finally` 就不执行 → 循环永久死亡，且不抛错、不打日志。
 * 生产上流水线因此静默停摆 13 天，积压 51 条任务。
 */
test('单次轮询永久挂起时，后续轮询仍然继续（核心修复）', async () => {
  let calls = 0;
  let stalls = 0;

  const poller = createResilientPoller({
    intervalMs: 10,
    stallThresholdMs: 25,
    watchdogIntervalMs: 10,
    poll: () => {
      calls += 1;
      // 第一次永久挂起——模拟数据库连接被池化器断开、promise 不落地
      if (calls === 1) return new Promise(() => {});
      return Promise.resolve();
    },
    onPollError: () => {},
    onStall: () => {
      stalls += 1;
    },
  });

  poller.start();
  await sleep(150);
  poller.stop();

  assert.ok(calls > 1, `挂起后应继续轮询，实际只调用了 ${calls} 次`);
  assert.ok(stalls >= 1, 'watchdog 应报告至少一次卡死');
});

test('轮询抛错会走 onPollError，且不影响下一轮', async () => {
  let calls = 0;
  const errors = [];

  const poller = createResilientPoller({
    intervalMs: 20,
    stallThresholdMs: 1_000,
    watchdogIntervalMs: 20,
    poll: () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve();
    },
    onPollError: (error) => errors.push(error),
    onStall: () => {},
  });

  poller.start();
  await sleep(150);
  poller.stop();

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /boom/);
  assert.ok(calls > 1, '出错后应继续轮询');
});

test('卡死计数会累加，便于告警阈值判断', async () => {
  let stalls = 0;

  const poller = createResilientPoller({
    intervalMs: 10,
    stallThresholdMs: 25,
    watchdogIntervalMs: 10,
    poll: () => new Promise(() => {}), // 永远挂起
    onPollError: () => {},
    onStall: () => {
      stalls += 1;
    },
  });

  poller.start();
  await sleep(150);
  poller.stop();

  assert.ok(stalls >= 2, `持续挂起应反复上报，实际 ${stalls} 次`);
});

test('stop() 之后不再轮询', async () => {
  let calls = 0;

  const poller = createResilientPoller({
    intervalMs: 20,
    stallThresholdMs: 1_000,
    watchdogIntervalMs: 20,
    poll: () => {
      calls += 1;
      return Promise.resolve();
    },
    onPollError: () => {},
    onStall: () => {},
  });

  poller.start();
  await sleep(100);
  const callsAtStop = calls;
  poller.stop();
  await sleep(120);

  assert.equal(calls, callsAtStop, 'stop 之后不应再有新的轮询');
  assert.equal(poller.snapshot().running, false);
});

test('正常轮询的 snapshot 能反映运行状态与完成时间', async () => {
  const poller = createResilientPoller({
    intervalMs: 20,
    stallThresholdMs: 1_000,
    watchdogIntervalMs: 20,
    poll: () => Promise.resolve(),
    onPollError: () => {},
    onStall: () => {},
  });

  poller.start();
  await sleep(120);
  const snapshot = poller.snapshot();
  poller.stop();

  assert.equal(snapshot.running, true, 'stop 前应处于运行态');
  assert.ok(snapshot.lastCompletedAt, '应记录上次完成时间');
  assert.equal(snapshot.stalledCount, 0, '正常轮询不应有卡死');
});
