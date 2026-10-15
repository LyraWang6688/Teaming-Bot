/**
 * 模型名的读取。
 *
 * 这条曾经埋着一个隐患：兜底写死成 `'doubao-seed-2-0-pro-260215'`——一个带日期后缀的
 * 豆包接入点。这类接入点会过期，而"静默回退到一个失效模型"的表现为**分析失败**，
 * 排查时会先怀疑提示词、逐字稿、网络、额度，很久之后才会想到是模型名的问题。
 *
 * 所以测试盯两件：
 *   ① 缺配置时【明确报错】，而不是猜一个模型名
 *   ② 配了就用配的，且优先级顺序不乱（换模型时才能"只加变量、不改代码"）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const PROVIDER_PATH = 'src/lib/analysis/provider.ts';

const ENV_KEYS = [
  'LLM_API_KEY', 'LLM_BASE_URL',
  'DOUBAO_API_KEY', 'DOUBAO_BASE_URL', 'DOUBAO_MODEL',
  'ARK_API_KEY', 'ARK_BASE_URL', 'ARK_MODEL',
  'ANALYSIS_MODEL',
];

/** 在干净的环境里加载 provider，避免宿主的 .env 干扰 */
function loadProvider(env) {
  const code = ts.transpileModule(fs.readFileSync(PROVIDER_PATH, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const cleanEnv = {};
  for (const k of Object.keys(process.env)) {
    if (!ENV_KEYS.includes(k)) cleanEnv[k] = process.env[k];
  }
  Object.assign(cleanEnv, env);

  const exportsObj = {};
  vm.runInNewContext(code, {
    exports: exportsObj,
    require(name) {
      // provider 只依赖 node 内置；这里给最小替身即可（本测试不发起网络请求）
      if (name === 'node:https' || name === 'node:http' || name === 'https' || name === 'http') {
        return { request: () => ({ on: () => {}, end: () => {}, write: () => {} }) };
      }
      if (name === 'node:crypto' || name === 'crypto') return { randomUUID: () => 'uuid' };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    console,
    process: { ...process, env: cleanEnv },
    Date,
    Promise,
    JSON,
    Error,
    Number,
    Boolean,
    String,
    Array,
    Object,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async () => {
      throw new Error('本测试不应发起网络请求');
    },
    TextDecoder,
  });
  return exportsObj;
}

test('缺配置 → 明确报错（不再静默回退到硬编码模型名）', () => {
  const { getProviderStatus } = loadProvider({});
  assert.throws(
    () => getProviderStatus(),
    (err) => {
      assert.match(err.message, /未配置分析模型/);
      assert.match(err.message, /ANALYSIS_MODEL/);
      return true;
    },
  );
});

test('配了 DOUBAO_MODEL → 用它（历史命名仍可用）', () => {
  const { getProviderStatus } = loadProvider({ DOUBAO_MODEL: 'ep-20260617210135-lpxtn' });
  assert.equal(getProviderStatus().model, 'ep-20260617210135-lpxtn');
});

test('ANALYSIS_MODEL 优先于 DOUBAO_MODEL（换模型时只加变量、不改代码）', () => {
  const { getProviderStatus } = loadProvider({
    DOUBAO_MODEL: '旧的豆包接入点',
    ANALYSIS_MODEL: 'deepseek-flash',
  });
  assert.equal(getProviderStatus().model, 'deepseek-flash');
});

test('getModel 里不再有字符串字面量兜底', () => {
  const src = fs.readFileSync(PROVIDER_PATH, 'utf8');
  // 只看实现体，不看注释——注释里会为了解释"为什么删掉它"而提到旧模型名
  const fn = src.slice(src.indexOf('function getModel()'), src.indexOf('export function getProviderStatus'));
  assert.ok(
    !/\|\|\s*'[^']+'/.test(fn),
    '取值链末尾不应再挂字符串字面量；接入点会过期，缺配置就该报错',
  );
  assert.match(fn, /throw new Error/, '缺配置时要抛错');
});

test('代码里不读取 ANALYSIS_PROVIDER（它不控制任何行为）', () => {
  const src = fs.readFileSync(PROVIDER_PATH, 'utf8');
  assert.ok(
    !/process\.env\.ANALYSIS_PROVIDER/.test(src),
    'ANALYSIS_PROVIDER 从未被读取，改它不会换模型；代码里不应假装它会生效',
  );
});
