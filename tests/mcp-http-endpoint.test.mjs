/**
 * MCP over HTTP。
 *
 * 这是给宿主用的**远程** MCP 端点：只要一个 URL + 一个接入码，不用装任何东西。
 *
 * 测试重点：
 *   ① 协议握手正确 —— 宿主靠它判断"对面是不是 MCP、支持什么"
 *   ② 工具清单只含【服务器能独立完成的】—— 需要用户本机飞书能力的不该出现
 *   ③ 认证复用 host token，未授权要明确拒绝
 *   ④ 通知类请求按规范不返回响应体
 *   ⑤ 工具出错时是 isError=true 的**正常响应**，不是 JSON-RPC 错误
 *      （MCP 约定：工具执行失败属于业务结果，不属协议错误）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const ROUTE_PATH = 'src/app/api/mcp/route.ts';

function loadRoute({ authorized = true } = {}) {
  const calls = { monitor: [] };

  const code = ts.transpileModule(fs.readFileSync(ROUTE_PATH, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const exportsObj = {};
  vm.runInNewContext(code, {
    exports: exportsObj,
    require(name) {
      if (name === 'next/server') {
        // 需要一个真能被 new 的构造函数（路由里用它返回 202 无 body）
        class MockNextResponse {
          constructor(body, init) {
            this.body = body;
            this.status = init?.status ?? 200;
          }
          static json(body, init) {
            return { body, status: init?.status ?? 200 };
          }
        }
        return { NextRequest: class {}, NextResponse: MockNextResponse };
      }
      if (name === 'node:crypto') {
        return { createHash: () => ({ update: () => ({ digest: () => ({ slice: () => 'abc123' }) }) }) };
      }
      if (name === '@/lib/host/hostAuth') {
        return {
          authorizeHostRequest: async () =>
            authorized
              ? { ok: true, integrationId: 'integ-1', source: 'credential', credential: { credentialId: 'c1' } }
              : { ok: false, status: 401, error: '缺少宿主凭证。' },
        };
      }
      if (name === '@/lib/host/hostEnrollmentStore') return { touchHostCredential: async () => {} };
      if (name === '@/lib/feishu/integration/integrationStore') {
        return {
          getFeishuIntegrationContextById: async (id) => ({ id, userId: 'u1', name: '宿主通道-测试', projectId: 'p1' }),
        };
      }
      if (name === '@/lib/feishu/common/monitor') {
        return {
          logFeishuMonitor: (level, event, ctx) => calls.monitor.push({ level, event, ctx }),
          toErrorContext: (e) => ({ message: String(e?.message || e) }),
        };
      }
      if (name === '@/services/analysisService') {
        return {
          analyzeMeetingText: async () => ({
            teamState: { zone: 'Learning', zoneLabel: '学习区' },
            metadata: { meetingType: '项目同步', participantCount: 3 },
          }),
        };
      }
      if (name === '@/lib/reports/meetingReportStore') {
        return {
          MEETING_REPORT_SCHEMA_VERSION: 2,
          getMeetingRecordByIntegrationAndMeeting: async () => null,
          persistMeetingReport: async () => {},
          updateMeetingRecordTranscript: async () => {},
          upsertMeetingRecord: async () => ({ id: 'r1', reportPublicId: 'pub-1', dataVersion: 1 }),
        };
      }
      if (name === '@/lib/reports/reportUrl') {
        return { buildPersistentReportUrl: (id) => `https://meeting.bamamei.online/report/v2/${id}` };
      }
      if (name === '@/lib/feishu/projects/projectConfigStore') {
        return { listActiveProjectOrgTargets: async () => ({ project: null, targets: [] }) };
      }
      if (name === '@/lib/feishu/delivery/baseSyncTaskStore') {
        return { enqueueBaseSyncTask: async () => null };
      }
      if (name === '@/lib/analysis/abcGate') {
        return { AbcGateError: class AbcGateError extends Error {} };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { ...process, env: { ...process.env } },
    console,
    Date,
    JSON,
    Error,
    String,
    Object,
    Array,
    NextResponse: undefined,
  });

  return { ...exportsObj, calls };
}

function rpc(method, params, id = 1) {
  return { json: async () => ({ jsonrpc: '2.0', id, method, params }) };
}

test('initialize 返回协议版本、服务信息与 instructions', async () => {
  const { POST } = loadRoute();
  const res = await POST(rpc('initialize', { protocolVersion: '2025-06-18' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.result.protocolVersion, '2025-06-18');
  assert.equal(res.body.result.serverInfo.name, 'teaming');
  assert.ok(res.body.result.capabilities.tools, '要声明支持 tools');
  assert.match(res.body.result.instructions, /远程/);
  assert.match(res.body.result.instructions, /用你自己的飞书能力|你自己的飞书能力/);
});

test('★ tools/list 只含服务器能独立完成的工具', async () => {
  const { POST } = loadRoute();
  const res = await POST(rpc('tools/list', {}));
  const names = res.body.result.tools.map((t) => t.name);

  // 跨 vm 边界的数组原型不同，deepStrictEqual 会失败，用 join 比较内容
  assert.equal(
    [...names].sort().join(','),
    ['teaming_analyze_transcript', 'teaming_doctor', 'teaming_read_report', 'teaming_report_card']
      .sort()
      .join(','),
  );

  // 需要用户本机 lark-cli 的两个不该出现 —— 按 ADR-003，取数由宿主自己做
  for (const forbidden of ['teaming_list_meetings', 'teaming_analyze_meeting', 'teaming_push_report']) {
    assert.ok(!names.includes(forbidden), `${forbidden} 依赖本机飞书能力，远程端点不该提供`);
  }
});

test('未授权 → 401 且是 JSON-RPC 错误', async () => {
  const { POST } = loadRoute({ authorized: false });
  const res = await POST(rpc('tools/list', {}));
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, -32001);
});

test('非法 JSON → -32700', async () => {
  const { POST } = loadRoute();
  const res = await POST({ json: async () => { throw new Error('bad'); } });
  assert.equal(res.body.error.code, -32700);
});

test('未知方法 → -32601', async () => {
  const { POST } = loadRoute();
  const res = await POST(rpc('resources/list', {}));
  assert.equal(res.body.error.code, -32601);
});

test('★ 通知类请求不返回响应体（规范要求）', async () => {
  const { POST } = loadRoute();
  const res = await POST(rpc('notifications/initialized', {}, null));
  assert.equal(res.status, 202);
  // 无响应体：undefined 或 null 都算（跨 vm 边界时可能是 null）
  assert.ok(res.body == null, `通知不该返回响应体，实际是 ${JSON.stringify(res.body)}`);
});

test('ping 返回空结果', async () => {
  const { POST } = loadRoute();
  const res = await POST(rpc('ping', {}));
  // 跨 vm 边界的对象原型不同，deepStrictEqual 会因原型不一致失败，改用键数断言
  assert.equal(Object.keys(res.body.result).length, 0);
});

test('teaming_doctor 报出 token 的归属', async () => {
  const { POST } = loadRoute();
  const res = await POST(rpc('tools/call', { name: 'teaming_doctor', arguments: {} }));
  const payload = JSON.parse(res.body.result.content[0].text);
  assert.equal(payload.ready, true);
  assert.equal(payload.integration_id, 'integ-1');
  assert.equal(payload.identity, 'host_token');
});

test('★ 未知工具 / 缺参数是 isError 的正常响应，不是 JSON-RPC 错误', async () => {
  const { POST } = loadRoute();

  const unknown = await POST(rpc('tools/call', { name: 'teaming_nope', arguments: {} }));
  assert.equal(unknown.body.error, undefined, '工具级失败不该走 JSON-RPC error');
  assert.equal(unknown.body.result.isError, true);

  const missing = await POST(rpc('tools/call', { name: 'teaming_analyze_transcript', arguments: {} }));
  assert.equal(missing.body.result.isError, true);
  assert.match(missing.body.result.content[0].text, /transcript/);
});

test('teaming_analyze_transcript 传逐字稿 → 出报告链接', async () => {
  const { POST } = loadRoute();
  const res = await POST(
    rpc('tools/call', {
      name: 'teaming_analyze_transcript',
      arguments: { transcript: '张三 00:00:15 我们先过一下议程', feishuMeetingId: '7696793654715174080' },
    }),
  );
  const payload = JSON.parse(res.body.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.reused, false);
  assert.match(payload.report_url, /^https:\/\/meeting\.bamamei\.online\/report\/v2\//);
  assert.equal(payload.zone, 'Learning');
});

test('GET 明确拒绝（只接受 POST）', async () => {
  const { GET } = loadRoute();
  const res = await GET();
  assert.equal(res.status, 405);
});

test('★ 工具描述里不含"需要本机 lark-cli"之类的误导', async () => {
  const { POST } = loadRoute();
  const res = await POST(rpc('tools/list', {}));
  const all = JSON.stringify(res.body.result.tools);
  assert.ok(!/lark-cli/.test(all), '远程端点不该把用户引向本机 lark-cli');
});
