/**
 * 「方向」字段的可选写入。
 *
 * 背景：AI 宿主通道写入的报告没有组织方向——方向由运营侧在多维表格里自己选。
 * 但网页版链路（已跑两期、逻辑定死）必须保持原来的行为。
 *
 * 所以新增了可选标记 skipDirection：
 *   · 不传（网页版）      → 方向照旧写入 ✓ 行为一字不变
 *   · 传 true（宿主通道）  → 方向不写，留给运营侧 ✓
 *
 * 这个测试守两件事：
 *   1. mapSupabaseRowToBusinessFields 在 orgName 为空时不产出 direction 字段
 *      —— 这是"方向留空"能成立的底层前提；
 *   2. 标记的默认值是 false —— 谁忘了传也不会改变网页版行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, mocks) {
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    Date,
    URL,
    console,
    require(name) {
      if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
      return mocks[name];
    },
  });
  return exports;
}

const mocks = {
  '../pipeline/status': {
    FEISHU_PROCESS_STATUS: { completed: '已完成', failed: '分析失败' },
  },
  './bitableOpenApi': {
    createMeetingRecord: () => {},
    findMeetingRecordByMeetingId: () => {},
    updateMeetingRecordFields: () => {},
  },
  './fieldBinding': {
    resolveFieldName: () => {},
  },
};

/** 一条最小的会议记录；只保留映射会读到的字段。 */
const ROW = {
  feishuMeetingId: '7696543802324143373',
  topic: 'MCP 链路测试',
  status: 'completed',
  transcript: '张三 00:00:15 我们先过一下今天的议题',
  analysisSummary: '摘要',
  analysisZone: 'Apathy',
  reportUrl: 'https://meeting.bamamei.online/report/v2/abc',
  organizerOpenId: 'ou_test',
  lastErrorMessage: null,
  analysisResult: { teamState: { zoneLabel: '可能是冷漠区或舒适区' } },
};

test('给了 orgName 时「方向」照旧写入（网页版现状）', () => {
  const { mapSupabaseRowToBusinessFields } = load('src/lib/feishu/bitable/bitableSync.ts', mocks);
  const fields = mapSupabaseRowToBusinessFields(ROW, { orgName: '立项申报' });
  assert.equal(fields.direction, '立项申报', '网页版链路必须照旧写入方向');
});

test('orgName 为空时【不产出】direction 字段（宿主通道要留空）', () => {
  const { mapSupabaseRowToBusinessFields } = load('src/lib/feishu/bitable/bitableSync.ts', mocks);
  const fields = mapSupabaseRowToBusinessFields(ROW, { orgName: null });
  assert.ok(!('direction' in fields), '方向为空时不应产出 direction，否则 Base 里会被写成空串或 null');
});

test('省略 orgName 时同样不产出 direction（与传 null 等价）', () => {
  const { mapSupabaseRowToBusinessFields } = load('src/lib/feishu/bitable/bitableSync.ts', mocks);
  const fields = mapSupabaseRowToBusinessFields(ROW);
  assert.ok(!('direction' in fields));
});

test('其余业务字段不受 skipDirection 影响（留空只作用于方向）', () => {
  const { mapSupabaseRowToBusinessFields } = load('src/lib/feishu/bitable/bitableSync.ts', mocks);
  const withOut = mapSupabaseRowToBusinessFields(ROW, { orgName: null });
  const withName = mapSupabaseRowToBusinessFields(ROW, { orgName: '立项申报' });
  for (const key of ['meeting_id', 'meeting_name', 'process_status', 'transcript',
    'analysis_summary', 'zone', 'report_url']) {
    assert.deepEqual(withOut[key], withName[key], `${key} 不应受方向留空影响`);
  }
});

test('标记默认关闭：入参不传 skipDirection 时快照里是 false', () => {
  const src = fs.readFileSync('src/lib/feishu/delivery/baseSyncTaskStore.ts', 'utf8');
  assert.match(
    src,
    /skipDirection:\s*input\.skipDirection === true/,
    '快照里必须用 === true 归一化，保证"不传 = false = 现状"',
  );
});

test('渲染端只在标记为 true 时才让方向为空', () => {
  const src = fs.readFileSync('src/lib/feishu/delivery/baseSyncProcessor.ts', 'utf8');
  assert.match(
    src,
    /orgName:\s*snapshot\.skipDirection\s*\?\s*null\s*:\s*\(snapshot\.orgName \?\? orgTarget\.orgName\)/,
    '不传标记时必须走原来的 fallback，网页版行为不能变',
  );
});
