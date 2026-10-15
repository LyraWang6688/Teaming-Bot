/**
 * /api/host/v1/analyze —— 自动化通道（ADR-004）。
 *
 * 这个接口是三条形态（MCP / Skill / curl）共同的根，守两件最容易出错的事：
 *
 *   ① 逐字稿不合格时要返回【结构化的 400 + 明确错误码】，
 *      而不是笼统的 500 —— Skill 那边要据此告诉用户"这场会分析不了"，
 *      而不是去重试或编造报告。
 *
 *   ② 幂等命中时【不能调模型】—— 宿主 HTTP 超时后会重试，
 *      如果每次都重新分析，额度会被烧穿。
 *
 * 另外守一条安全边界：归属由凭证决定，调用方传 integrationId 无效。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const ROUTE_PATH = 'src/app/api/host/v1/analyze/route.ts';

function load(path, mocks) {
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    Date,
    console,
    require(name) {
      if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
      return mocks[name];
    },
  });
  return exports;
}


/** 记录引擎被调用的次数与入参，用来验证"幂等命中不调模型"。 */
/** 与真实 AbcGateError 等价的最小实现；供 mock 与测试共用，保证 instanceof 成立 */
class MockAbcGateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AbcGateError';
  }
}

function makeHarness({ analyzeImpl, existingRecord = null } = {}) {
  const calls = { analyze: 0, enqueue: 0 };
  const monitors = [];
  let injectedError = null;

  const code = ts.transpileModule(fs.readFileSync(ROUTE_PATH, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const exportsObj = {};
  const mocks = {
    'next/server': {
      NextRequest: class {},
      NextResponse: {
        json: (body, init) => ({ body, status: init?.status ?? 200 }),
      },
    },
    'node:crypto': {
      createHash: () => ({ update: () => ({ digest: () => ({ slice: () => 'deadbeefdeadbeefdeadbeef' }) }) }),
    },
    '@/lib/analysis/abcGate': {
      // 唯一来源：测试和 route 必须共用同一个类，否则 instanceof 会因 vm 隔离失效
      AbcGateError: MockAbcGateError,
    },
    '@/services/analysisService': {
      analyzeMeetingText: async (text) => {
        calls.analyze += 1;
        if (injectedError) throw injectedError;
        if (analyzeImpl) return analyzeImpl(text);
        return {
          teamState: { zone: 'Apathy', zoneLabel: '可能是冷漠区或舒适区' },
          metadata: { meetingType: '技术支持/排障', durationLabel: '7分钟 43秒', participantCount: 3 },
        };
      },
    },
    '@/lib/feishu/integration/integrationStore': {
      getFeishuIntegrationContextById: async (id) => ({ id, userId: 'user-1' }),
    },
    '@/lib/host/hostAuth': {
      // 默认：带 token 就通过，归属固定为 integ-1
      authorizeHostRequest: async (request) =>
        request.__noAuth
          ? { ok: false, status: 401, error: '缺少宿主凭证。', hint: '请配置 TEAMING_HOST_TOKEN。' }
          : { ok: true, integrationId: 'integ-1', source: 'credential', credential: { credentialId: 'cred-1' } },
    },
    '@/lib/host/hostEnrollmentStore': { touchHostCredential: async () => {} },
    '@/lib/feishu/common/monitor': {
      logFeishuMonitor: (level, event, ctx) => monitors.push({ level, event, ctx }),
      toErrorContext: (e) => ({ message: String(e?.message || e) }),
    },
    '@/lib/reports/meetingReportStore': {
      MEETING_REPORT_SCHEMA_VERSION: 2,
      getMeetingRecordById: async () => existingRecord,
      getMeetingRecordByIntegrationAndMeeting: async () => existingRecord,
      upsertMeetingRecord: async () => ({ id: 'rec-1', reportPublicId: 'pub-1', dataVersion: 1 }),
      updateMeetingRecordTranscript: async () => {},
      persistMeetingReport: async () => {},
    },
    '@/lib/reports/reportUrl': {
      buildPersistentReportUrl: (id) => `https://meeting.bamamei.online/report/v2/${id}`,
    },
    '@/lib/feishu/projects/projectConfigStore': {
      listActiveProjectOrgTargets: async () => ({
        project: { id: 'proj-1', projectKey: '2026-09-phase-4', bitableAppToken: 'tok', bitableTableId: 'tbl' },
        targets: [{ id: 'target-1', orgName: '关系管理' }],
      }),
    },
    '@/lib/feishu/delivery/baseSyncTaskStore': {
      enqueueBaseSyncTask: async () => {
        calls.enqueue += 1;
        return null;
      },
    },
  };

  vm.runInNewContext(code, {
    exports: exportsObj,
    require(name) {
      if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
      return mocks[name];
    },
    console,
    process,
    Date,
    JSON,
    Promise,
  });

  return {
    POST: exportsObj.POST,
    calls,
    monitors,
    setAnalyzeError(error) {
      injectedError = error;
    },
  };
}

function makeRequest(body, { noAuth = false } = {}) {
  return {
    __noAuth: noAuth,
    json: async () => body,
  };
}

test('缺 transcript → 400 且错误码是 transcript_missing', async () => {
  const h = makeHarness();
  const res = await h.POST(makeRequest({ title: '某场会' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'transcript_missing');
  assert.equal(h.calls.analyze, 0, '参数不合法时不应调模型');
});

test('逐字稿过短 → 400 + transcript_too_short（不能是 500）', async () => {
  const h = makeHarness({
    analyzeImpl: () => {
      throw new Error('会议文本过短，请上传包含完整发言记录的文件。');
    },
  });
  const res = await h.POST(makeRequest({ transcript: '太短了' }));
  assert.equal(res.status, 400, '不合格输入必须是 400，不能是 500');
  assert.equal(res.body.error.code, 'transcript_too_short');
  assert.equal(res.body.error.type, 'transcript');
  assert.ok(res.body.error.hint, '要给出下一步该怎么做');
});

test('发言者不足 → 400 + transcript_not_speaker_lines', async () => {
  const h = makeHarness({
    analyzeImpl: () => {
      throw new Error('未识别到至少两位实质发言者，暂不生成团队互动报告。');
    },
  });
  const res = await h.POST(makeRequest({ transcript: '张三 00:00:15 我说一句' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'transcript_not_speaker_lines');
});

test('引擎的其它异常 → 422 + analysis_failed（可重试那类）', async () => {
  const h = makeHarness({
    analyzeImpl: () => {
      throw new Error('模型返回为空');
    },
  });
  const res = await h.POST(makeRequest({ transcript: '张三 00:00:15 我说一句' }));
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'analysis_failed');
});

test('幂等命中 → reused=true 且【不调模型】', async () => {
  const h = makeHarness({
    existingRecord: {
      id: 'rec-1',
      status: 'completed',
      reportPublicId: 'pub-existing',
      reportUrl: 'https://meeting.bamamei.online/report/v2/pub-existing',
      analysisZone: 'Apathy',
      analysisResult: { teamState: { zoneLabel: '可能是冷漠区或舒适区' } },
    },
  });
  const res = await h.POST(makeRequest({ transcript: '张三 00:00:15 我说一句' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.reused, true);
  assert.equal(res.body.reportUrl, 'https://meeting.bamamei.online/report/v2/pub-existing');
  assert.equal(h.calls.analyze, 0, '命中幂等时绝对不能重新分析——否则超时重试会烧穿额度');
});

test('未授权 → 401', async () => {
  const h = makeHarness();
  const res = await h.POST(makeRequest({ transcript: 'x' }, { noAuth: true }));
  assert.equal(res.status, 401);
  assert.equal(res.body.error.type, 'auth');
});

test('归属由凭证决定：body 里传 integrationId 不生效', async () => {
  const h = makeHarness();
  const res = await h.POST(
    makeRequest({ transcript: '张三 00:00:15 我说一句', integrationId: '别人 的 集成' })
  );
  assert.equal(res.status, 200);
  const events = h.monitors.map((m) => m.event);
  assert.ok(
    events.includes('host_analyze_completed'),
    '应正常完成分析，而不是把 integrationId 当参数用'
  );
});

test('与 ABC 无关 → 400 not_abc_related（而不是 422 或 500）', async () => {
  const h = makeHarness();
  // 验证接口靠 instanceof 识别，而不是靠消息里有没有 "ABC" 这种脆弱匹配
  h.setAnalyzeError(new MockAbcGateError('这场会与「ABC 向善公益实战营」无关，已跳过分析。'));
  const res = await h.POST(makeRequest({ transcript: '张三 00:00:15 我们过一下排期' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'not_abc_related');
  assert.equal(res.body.error.type, 'transcript');
});

test('成功后会把报告登记进 Base 同步队列（归属后置）', async () => {
  const h = makeHarness();
  await h.POST(makeRequest({ transcript: '张三 00:00:15 我说一句', title: '某场会' }));
  assert.equal(h.calls.enqueue, 1, '宿主通道的报告必须入队，否则进不了多维表格');
});
