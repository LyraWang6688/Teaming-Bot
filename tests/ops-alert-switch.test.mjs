/**
 * 运维告警的推送开关与冷却。
 *
 * 2026-10-15 的决定：**先关掉推送**，需要时再打开。
 * 起因是健康检查长期报「异常 22」（21 个授权失效的僵尸集成），
 * 告警内容反复相同，反而淹没了真正的新问题。
 *
 * 关掉的只是"推送"这一层——**审计照写、日志照记**。所以测试盯的是：
 *
 *   ① 关了之后确实不发 HTTP 请求
 *   ② 但审计仍然落库（否则事后就没法追溯了）
 *   ③ 不设开关时保持历史行为（配了收件人就发）—— 向后兼容
 *   ④ 冷却期内同 key 不重复发
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const SERVICE_PATH = 'src/lib/feishu/ops/opsAlertService.ts';

/** 加载告警服务，记录它调了哪些外部依赖 */
function loadService({ env = {}, recentAlert = false } = {}) {
  const calls = { sent: [], audit: [], monitor: [] };

  const code = ts.transpileModule(fs.readFileSync(SERVICE_PATH, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const exportsObj = {};
  vm.runInNewContext(code, {
    exports: exportsObj,
    require(name) {
      if (name === 'drizzle-orm') {
        return {
          and: (...a) => ({ and: a }),
          desc: (c) => ({ desc: c }),
          eq: (c, v) => ({ eq: [c, v] }),
          gte: (c, v) => ({ gte: [c, v] }),
          sql: Object.assign(() => ({}), { }),
        };
      }
      if (name === '@/lib/db/client') {
        return {
          getDb: () => ({
            select: () => ({
              from: () => ({
                where: () => ({
                  orderBy: () => ({
                    limit: async () => (recentAlert ? [{ id: 'recent' }] : []),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (name === '@/lib/db/schema') {
        return { feishuAuditLogs: { id: 'id', action: 'action', createdAt: 'createdAt', metadata: 'metadata' } };
      }
      if (name === '../integration/integrationOpenApi') {
        return {
          callGlobalBaseAppTenantOpenApi: async (method, path, body) => {
            calls.sent.push({ method, path, body });
          },
        };
      }
      if (name === '../integration/integrationStore') {
        return {
          writeAuditLog: async (input) => {
            calls.audit.push(input);
          },
        };
      }
      if (name === '../common/monitor') {
        return {
          logFeishuMonitor: (level, event, ctx) => calls.monitor.push({ level, event, ctx }),
          toErrorContext: (e) => ({ message: String(e?.message || e) }),
        };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { ...process, env: { ...process.env, ...env } },
    console,
    Date,
    JSON,
    Error,
    Number,
    String,
  });

  return { ...exportsObj, calls };
}

const RECIPIENT = { OPS_ALERT_CHAT_ID: 'oc_test_recipient' };

test('不设开关时保持历史行为（配了收件人就发）', async () => {
  const svc = loadService({ env: RECIPIENT });
  const r = await svc.sendOpsAlert({ title: 'T', markdown: 'M' });
  assert.equal(r.sent, true);
  assert.equal(svc.calls.sent.length, 1);
});

test('★ OPS_ALERT_ENABLED=false 时不发请求', async () => {
  const svc = loadService({ env: { ...RECIPIENT, OPS_ALERT_ENABLED: 'false' } });
  const r = await svc.sendOpsAlert({ title: 'T', markdown: 'M' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'push_disabled');
  assert.equal(svc.calls.sent.length, 0, '关了开关就绝不能发出去');
});

test('★ 关了推送，但审计照写 —— 事后仍可追溯', async () => {
  const svc = loadService({ env: { ...RECIPIENT, OPS_ALERT_ENABLED: 'false' } });
  await svc.sendOpsAlert({ title: 'T', markdown: 'M', idempotencyKey: 'k1' });
  assert.equal(svc.calls.audit.length, 1, '审计必须落库，否则关掉推送就等于把证据也丢了');
  assert.equal(svc.calls.audit[0].action, 'ops_alert_suppressed_disabled');
  assert.equal(svc.calls.audit[0].metadata.idempotencyKey, 'k1');
});

test('几种"关"的写法都认（false / 0 / off / no，大小写不敏感）', async () => {
  for (const v of ['false', 'FALSE', '0', 'off', 'OFF', 'no', ' no ']) {
    const svc = loadService({ env: { ...RECIPIENT, OPS_ALERT_ENABLED: v } });
    const r = await svc.sendOpsAlert({ title: 'T', markdown: 'M' });
    assert.equal(r.sent, false, `OPS_ALERT_ENABLED=${v} 应视为关闭`);
  }
});

test('true / 1 / 空串 视为开启（空串 = 保持默认）', async () => {
  for (const v of ['true', '1', 'on', '']) {
    const svc = loadService({ env: { ...RECIPIENT, OPS_ALERT_ENABLED: v } });
    const r = await svc.sendOpsAlert({ title: 'T', markdown: 'M' });
    assert.equal(r.sent, true, `OPS_ALERT_ENABLED=${v} 应视为开启`);
  }
});

test('★ 冷却期内同 key 不重复发', async () => {
  const svc = loadService({ env: RECIPIENT, recentAlert: true });
  const r = await svc.sendOpsAlert({ title: 'T', markdown: 'M', idempotencyKey: 'delivery_health:error' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'suppressed_by_cooldown');
  assert.equal(svc.calls.sent.length, 0);
});

test('isOpsAlertConfigured 在关闭时返回 false', async () => {
  const on = loadService({ env: RECIPIENT });
  assert.equal(on.isOpsAlertConfigured(), true);
  const off = loadService({ env: { ...RECIPIENT, OPS_ALERT_ENABLED: 'false' } });
  assert.equal(off.isOpsAlertConfigured(), false);
});
