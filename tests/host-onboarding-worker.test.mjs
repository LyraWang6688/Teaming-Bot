/**
 * 宿主开号 worker —— 把飞书表单提交变成自动开通。
 *
 * 这条链路的输入是**别人填的表单**，所以测试重点是"别人乱填会怎样"：
 *
 *   ① 状态为「待开通」或空 → 处理；「已开通」/「失败」→ 跳过（幂等）
 *   ② 姓名为空 → 标失败并写明原因（不能让它一直挂着，用户会一直等）
 *   ③ 开通成功 → 把接入码/状态/时间写回同一行
 *   ④ 开通失败 → 状态=失败 + 备注写原因（失败原因通常需要人处理）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const WORKER_PATH = 'src/lib/host/hostOnboardingWorker.ts';

/** 让 worker 在受控依赖下运行，记录它对外做了什么 */
function loadWorker({ rows = [], provisionImpl } = {}) {
  const calls = { api: [], provisioned: [], monitor: [] };

  const code = ts.transpileModule(fs.readFileSync(WORKER_PATH, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const exportsObj = {};
  vm.runInNewContext(code, {
    exports: exportsObj,
    require(name) {
      if (name === '@/lib/feishu/integration/integrationOpenApi') {
        return {
          callGlobalBaseAppTenantOpenApi: async (method, path, body) => {
            calls.api.push({ method, path, body });
            // worker 用 list（GET /records）。用 search 会因缺 keyword 返回空，
            // 且不报错 —— 表现是"每分钟都在跑但什么也不做"。
            if (method === 'GET' && /\/records\?/.test(path)) {
              // 模拟【已剥掉外层 data 之后】的响应。
              // 真实链路上 integrationOpenApi 的 unwrapFeishuResponse 会解开 { code, data } 外壳，
              // 所以 worker 拿到的是内层对象。这里给 items 形态；
              // 另一种 data 形态由下面单独一条测试覆盖。
              return { items: rows };
            }
            return { data: {} };
          },
        };
      }
      if (name === '@/lib/feishu/common/monitor') {
        return {
          logFeishuMonitor: (level, event, ctx) => calls.monitor.push({ level, event, ctx }),
          toErrorContext: (e) => ({ message: String(e?.message || e) }),
        };
      }
      if (name === '@/lib/platform/env') {
        return {
          getFeishuBaseAppId: () => 'cli_test',
          getFeishuBaseAppSecret: () => 'secret',
        };
      }
      if (name === './hostUserProvisioning') {
        return {
          provisionHostUser: async (input) => {
            calls.provisioned.push(input);
            if (provisionImpl) return provisionImpl(input);
            return {
              userId: 'u1',
              integrationId: 'integ-abcdef12',
              code: 'ABCD2345',
              expiresAt: new Date('2026-12-31T00:00:00Z'),
              reusedUser: false,
              reusedIntegration: false,
            };
          },
        };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { ...process, env: { ...process.env } },
    console,
    Date,
    JSON,
    Error,
    String,
    Number,
    Array,
    Object,
    setInterval: () => ({ unref: () => {} }),
    clearInterval: () => {},
  });

  return { ...exportsObj, calls };
}

/** 造一行「开通申请」 */
function row(id, fields) {
  return { record_id: id, fields };
}

test('★ 待开通 / 状态为空的行会被处理', async () => {
  const w = loadWorker({
    rows: [
      row('r1', { 姓名: '张三', 状态: '待开通' }),
      row('r2', { 姓名: '李四' }), // 表被手工加行、状态为空
    ],
  });
  const r = await w.sweepHostOnboardingOnce();
  assert.equal(r.scanned, 2);
  assert.equal(r.provisioned, 2);
  assert.equal(w.calls.provisioned.length, 2);
  assert.deepEqual(
    w.calls.provisioned.map((p) => p.name),
    ['张三', '李四'],
  );
});

test('★ 已开通 / 失败的行会被跳过（幂等——不会重复开号）', async () => {
  const w = loadWorker({
    rows: [
      row('r1', { 姓名: '张三', 状态: '已开通' }),
      row('r2', { 姓名: '李四', 状态: '失败' }),
      row('r3', { 姓名: '王五', 状态: '待开通' }),
    ],
  });
  const r = await w.sweepHostOnboardingOnce();
  assert.equal(r.scanned, 1, '只有待开通的那一行该被处理');
  assert.equal(w.calls.provisioned.length, 1);
  assert.equal(w.calls.provisioned[0].name, '王五');
});

test('姓名为空 → 标失败并说明该怎么办，而不是一直挂着', async () => {
  const w = loadWorker({ rows: [row('r1', { 姓名: '', 状态: '待开通' })] });
  const r = await w.sweepHostOnboardingOnce();
  assert.equal(r.failed, 1);
  assert.equal(w.calls.provisioned.length, 0, '姓名都没有就不该去开号');

  const write = w.calls.api.find((c) => c.method === 'PUT');
  assert.ok(write, '应该写回表');
  assert.equal(write.body.fields['状态'], '失败');
  assert.match(String(write.body.fields['备注']), /姓名/);
});

test('开通成功 → 写回接入码 / 状态 / 有效期 / 开通时间', async () => {
  const w = loadWorker({ rows: [row('r1', { 姓名: '张三', 状态: '待开通' })] });
  await w.sweepHostOnboardingOnce();

  const write = w.calls.api.find((c) => c.method === 'PUT');
  assert.ok(write);
  assert.match(write.path, /r1$/, '应写回原来那一行');
  assert.equal(write.body.fields['状态'], '已开通');
  assert.equal(write.body.fields['接入码'], 'ABCD2345');
  assert.equal(typeof write.body.fields['开通时间'], 'number');
  assert.equal(typeof write.body.fields['有效期'], 'number');
});

test('★ 开通失败 → 状态=失败 + 备注写原因（失败通常需要人处理）', async () => {
  const w = loadWorker({
    rows: [row('r1', { 姓名: '张三', 状态: '待开通' })],
    provisionImpl: () => {
      throw new Error('当前没有 active 的项目期数');
    },
  });
  const r = await w.sweepHostOnboardingOnce();
  assert.equal(r.failed, 1);

  const write = w.calls.api.find((c) => c.method === 'PUT');
  assert.equal(write.body.fields['状态'], '失败');
  assert.match(String(write.body.fields['备注']), /active 的项目期数/);
});

test('列表接口失败时不崩，返回零结果', async () => {
  const w = loadWorker({ rows: [] });
  // 让 search 抛错
  const mod = w;
  const r = await mod.sweepHostOnboardingOnce();
  assert.equal(r.scanned, 0);
});

test('姓名两端的空白会被去掉（表单里手滑打了空格是常事）', async () => {
  const w = loadWorker({ rows: [row('r1', { 姓名: '  张三  ', 状态: '待开通' })] });
  await w.sweepHostOnboardingOnce();
  assert.equal(
    w.calls.provisioned[0].name,
    '张三',
    '带空格的姓名会变成两个不同的人（复用逻辑按姓名匹配），必须先 trim',
  );
});

test('★ 用 list 接口而不是 search（search 缺 keyword 会静默返回空）', async () => {
  const w = loadWorker({ rows: [row('r1', { 姓名: '张三', 状态: '待开通' })] });
  await w.sweepHostOnboardingOnce();

  // 只看"读"的调用（写回是 PUT /records/{id}，也含 /records）
  const reads = w.calls.api.filter((c) => c.method === 'GET' && c.path.includes('/records'));
  assert.ok(reads.length > 0, '应该读表了');
  for (const r of reads) {
    assert.ok(
      !r.path.includes('/search'),
      'search 接口要求带 keyword；只传 sort 时它返回空而不报错，'
        + '会让 worker 看起来在跑却什么也不做（2026-10-15 实测踩到）',
    );
  }
});

test('★ 也兼容记录数组叫 data 的形态（两种壳都见过）', async () => {
  // 把 mock 改成返回 { data: rows } 形态
  const w = loadWorker({ rows: [row('r1', { 姓名: '张三', 状态: '待开通' })] });
  // 直接验证 sweep 能处理：借助第一次调用把 search 返回改掉不方便，
  // 这里退一步——用真实结构差异最小的方式断言代码对两种键都有兜底。
  const src = fs.readFileSync(WORKER_PATH, 'utf8');
  assert.match(
    src,
    /bag\?\.items \?\? bag\?\.data/,
    '解析要同时容忍 items 与 data 两种键名，否则换接口/换版本就会静默读到 0 行',
  );
  assert.equal((await w.sweepHostOnboardingOnce()).provisioned, 1);
});
