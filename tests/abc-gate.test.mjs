/**
 * ABC 相关性甄别。
 *
 * 这个过滤器决定「哪些会该出报告」。它错了会有两种后果，方向不对称：
 *
 *   · 假阴性（该分析却被跳过）→ 用户拿不到报告，更糟
 *   · 假阳性（不该分析却分析了）→ 只多花一点额度
 *
 * 所以测试盯这几件：
 *   ① 不相关要判出来（否则任何会都进报告）
 *   ② 甄别本身失败要【放行】而不是阻断（分类器抽风不该让用户拿不到报告）
 *   ③ 模型返回脏数据时要容错，不能崩
 *   ④ 内容过短直接判不相关（省一次调用）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const GATE_PATH = 'src/lib/analysis/abcGate.ts';

function loadGate({ invokeImpl }) {
  const code = ts.transpileModule(fs.readFileSync(GATE_PATH, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exportsObj = {};
  vm.runInNewContext(code, {
    exports: exportsObj,
    require(name) {
      if (name === './provider') {
        return {
          invokeJson: async (messages, options) => invokeImpl(messages, options),
        };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
    console,
    process,
    Date,
    Promise,
    JSON,
    Error,
  });
  return exportsObj;
}

/** 一段足够长的、看起来像会议逐字稿的内容 */
const TRANSCRIPT = Array.from({ length: 40 }, (_, i) =>
  `张三 00:${String(i).padStart(2, '0')}:15 我们先过一下今天要讨论的事项，第 ${i + 1} 点`
).join('\n');

test('模型判不相关 → related=false，并带上理由', async () => {
  let capturedMessages = null;
  const { evaluateAbcRelevance } = loadGate({
    invokeImpl: (messages) => {
      capturedMessages = messages;
      return { related: false, confidence: 'high', reason: '纯内部技术排障', matchedSignals: ['排障'] };
    },
  });
  const r = await evaluateAbcRelevance(TRANSCRIPT);
  assert.equal(r.related, false);
  assert.equal(r.confidence, 'high');
  assert.equal(r.reason, '纯内部技术排障');
  assert.deepEqual(r.matchedSignals, ['排障']);
  assert.ok(capturedMessages?.[0]?.content.includes('ABC'), '系统提示词里应说明 ABC 判据');
  assert.ok(capturedMessages?.[0]?.content.includes('宁可放宽'), '提示词里要有"宁可放宽"的原则');
});

test('模型判相关 → related=true', async () => {
  const { evaluateAbcRelevance } = loadGate({
    invokeImpl: () => ({ related: true, confidence: 'medium', reason: '在为公益机构做系统', matchedSignals: [] }),
  });
  const r = await evaluateAbcRelevance(TRANSCRIPT);
  assert.equal(r.related, true);
});

test('★ 甄别调用失败 → 放行（related=true），绝不因为分类器出错而漏报', async () => {
  const { evaluateAbcRelevance } = loadGate({
    invokeImpl: () => {
      throw new Error('模型返回为空');
    },
  });
  const r = await evaluateAbcRelevance(TRANSCRIPT);
  assert.equal(r.related, true, '甄别失败必须放行——漏报比多分析一场代价大');
  assert.equal(r.confidence, 'low');
  assert.match(r.reason, /放行/);
});

test('模型返回脏数据（缺字段 / 非法 confidence）也不崩', async () => {
  const { evaluateAbcRelevance } = loadGate({
    invokeImpl: () => ({ confidence: '很高', matchedSignals: [1, null, '公益'] }),
  });
  const r = await evaluateAbcRelevance(TRANSCRIPT);
  assert.equal(r.related, false, '缺 related 字段时按不相关处理');
  assert.equal(r.confidence, 'low', '非法 confidence 归到 low');
  assert.deepEqual(r.matchedSignals, ['公益'], '非字符串的 signal 要过滤掉');
});

test('内容过短 → 直接判不相关，不调模型', async () => {
  let called = false;
  const { evaluateAbcRelevance } = loadGate({
    invokeImpl: () => {
      called = true;
      return { related: true };
    },
  });
  const r = await evaluateAbcRelevance('太短');
  assert.equal(r.related, false);
  assert.equal(called, false, '过短内容不值得花一次模型调用');
});

test('长逐字稿只截取三段送模型（控成本）', async () => {
  let userContent = '';
  const { evaluateAbcRelevance } = loadGate({
    invokeImpl: (messages) => {
      userContent = messages[1].content;
      return { related: true, confidence: 'high', reason: '', matchedSignals: [] };
    },
  });
  // 要超过 buildExcerpt 的阈值（每段 2500 字符 × 3），否则它会（正确地）返回全文
  const long = `${'开头内容'.repeat(1200)}\n${'中段内容'.repeat(1200)}\n${'结尾内容'.repeat(1200)}`;
  await evaluateAbcRelevance(long);
  assert.ok(userContent.length < long.length, '不能把整篇送进去');
  assert.ok(userContent.includes('【开头】') && userContent.includes('【中段】') && userContent.includes('【结尾】'),
    '要取开头 + 中段 + 结尾，避免"先寒暄后入正题"的会被误判');
});
