import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, mocks, extra = {}) {
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, Date, URL, URLSearchParams, console,
    require(name) { if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`); return mocks[name]; },
    ...extra,
  });
  return exports;
}
class ApiError extends Error { constructor(code, statusCode) { super('provider detail'); this.code = code; this.statusCode = statusCode; } }
const minuteMocks = {
  '../integration/integrationOpenApi': {},
  '../common/monitor': { logFeishuMonitor() {} },
  '../common/openapi': { FeishuOpenApiError: ApiError },
  '../integration/integrationStore': { async writeAuditLog() {} },
};
const { MinuteInfoError } = load('src/lib/feishu/minutes/minuteInfo.ts', minuteMocks);
const integration = { id: 'owner-integration', appId: 'app-one', initializedAt: '2026-09-22', selectedOrgTargetId: 'org' };
function gateFixture({ topic = 'ABC test', owner = 'owner', authorized = 'owner', error, meetingError } = {}) {
  const calls = [];
  const gate = load('src/lib/feishu/pipeline/meetingEligibility.ts', {
    '../integration/integrationStore': { async getLatestFeishuAuthorizationContext(id) { calls.push(['authorization', id]); return { status: 'authorized', authorizedOpenId: authorized }; } },
    '../meetings/meetingDetailsService': { async fetchMeetingDetails(i) { calls.push(['meeting', i.id]); if (meetingError) throw meetingError; return { topic, hostOpenId: 'someone-else' }; } },
    '../minutes/minuteInfo': { MinuteInfoError, async fetchMinuteInfo(token, i) { calls.push(['minute', i.id]); if (error) throw error; return { ownerId: owner }; } },
  });
  return { calls, run: (i = integration) => gate.evaluateMeetingEligibility(i, 'meeting', 'minute') };
}

test('non-ABC creates no minute or authorization requests', async () => {
  const f = gateFixture({ topic: 'ordinary meeting' });
  const result = await f.run();
  assert.equal(result.status, 'skipped'); assert.equal(result.reasonCode, 'meeting_topic_keyword_mismatch');
  assert.deepEqual(f.calls.map(x => x[0]), ['meeting']);
});
test('shared minute: readable attendee is skipped even if integrated', async () => {
  const f = gateFixture({ authorized: 'attendee' });
  assert.equal((await f.run()).reasonCode, 'minute_not_owner');
});
test('unshared minute: one blocked outcome, never mislabeled as non-owner', async () => {
  const f = gateFixture({ error: new MinuteInfoError('minute_read_forbidden', 'no access', false) });
  const result = await f.run();
  assert.equal(result.status, 'blocked'); assert.equal(result.reasonCode, 'minute_read_forbidden');
  assert.deepEqual(f.calls.map(x => x[0]), ['meeting', 'minute']);
});
test('only initialized owner passes; host identity is not used', async () => {
  const f = gateFixture();
  const result = await f.run();
  assert.equal(result.allowed, true); assert.equal(result.details.organizerOpenId, 'owner');
  assert.equal((await f.run({ ...integration, initializedAt: null })).reasonCode, 'minute_owner_not_initialized');
});
test('transient failures remain retryable rather than skipped', async () => {
  const f = gateFixture({ error: new MinuteInfoError('minute_not_ready', 'wait', true) });
  await assert.rejects(f.run(), e => e.retryable === true);
  await assert.rejects(gateFixture({ topic: null }).run(), e => e.code === 'meeting_topic_unavailable');
});
test('missing owner or unavailable authorized identity fails closed', async () => {
  assert.equal((await gateFixture({ owner: null }).run()).reasonCode, 'minute_owner_missing');
  assert.equal((await gateFixture({ authorized: null }).run()).reasonCode, 'integration_authorization_invalid');
});
test('minute permission failure preserves reason and suppresses secondary failure logs', async () => {
  const logs = [];
  const m = load('src/lib/feishu/minutes/minuteInfo.ts', {
    ...minuteMocks,
    '../common/monitor': { logFeishuMonitor: (...x) => logs.push(x) },
    '../integration/integrationOpenApi': { async callFeishuIntegrationUserOpenApi(...args) { assert.equal(args[4].errorLogging, 'caller'); throw new ApiError(2091005, 403); } },
  });
  await assert.rejects(m.fetchMinuteInfo('minute', integration), e => e.code === 'minute_read_forbidden' && !e.retryable);
  assert.equal(logs.filter(x => x[0] === 'error').length, 0);
  assert.equal(m.mapMinuteInfoError(new ApiError(2091003, 400)).retryable, true);
  assert.equal(m.mapMinuteInfoError(new ApiError(123, 403)).code, 'minute_request_rejected');
  assert.equal(m.mapMinuteInfoError(new ApiError(999, 503)).retryable, true);
});

test('SDK logger never emits credentials from nested errors, strings or cycles', () => {
  const logs = [];
  const { createSafeFeishuSdkLogger } = load('src/lib/feishu/common/sdkLogger.ts', {
    '@/lib/platform/runtimeMonitor': { logRuntimeMonitor: (...x) => logs.push(x) },
  });
  const sensitive = new Error('Bearer SECRET_SENTINEL');
  Object.assign(sensitive, { isAxiosError: true, response: { status: 403, data: { code: 2091005, access_token: 'SECRET_SENTINEL' } }, request: { _header: 'Authorization: Bearer SECRET_SENTINEL' } });
  sensitive.self = sensitive;
  const cycle = []; cycle.push(cycle, sensitive);
  createSafeFeishuSdkLogger().error([cycle, 'token=SECRET_SENTINEL', { appSecret: 'SECRET_SENTINEL' }]);
  assert.equal(JSON.stringify(logs).includes('SECRET_SENTINEL'), false);
  assert.equal(logs[0][3].diagnostics[0].errorCode, 2091005);
  logs.length = 0;
  createSafeFeishuSdkLogger(true).error([sensitive]);
  assert.equal(logs.length, 0, 'API boundary owns request errors');
  createSafeFeishuSdkLogger(true).error(new Error('websocket failed'));
  assert.equal(logs.length, 1, 'non-request SDK errors remain observable');
});

function taskFixture() {
  const rows = [];
  const table = Object.fromEntries(['id','integrationId','feishuMeetingId','eventId','status','nextRunAt','updatedAt'].map(k => [k, k]));
  function matches(row, p) { return p.kind === 'and' ? p.parts.every(x => matches(row, x)) : row[p.key] === p.value; }
  const db = {
    insert() { return { values(data) { return { onConflictDoNothing() { return { async returning() {
      if (rows.some(r => r.integrationId === data.integrationId && (r.feishuMeetingId === data.feishuMeetingId || r.eventId === data.eventId))) return [];
      const row = { ...data, id: `task-${rows.length}` }; rows.push(row); return [row];
    } }; } }; } }; },
    select() { return { from() { return { where(predicate) { return { async limit() { return rows.filter(r => matches(r, predicate)).slice(0, 1); } }; } }; } }; },
    update() { throw new Error('Duplicate must not update existing task'); },
  };
  const store = load('src/lib/feishu/pipeline/meetingPipelineTaskStore.ts', {
    'drizzle-orm': { and: (...parts) => ({ kind:'and', parts }), eq: (key,value) => ({kind:'eq',key,value}), sql(){}, asc(){}, inArray(){} },
    '@/lib/db/client': { getDb: () => db }, '@/lib/db/schema': { meetingPipelineTasks: table },
    './status': { FEISHU_PROCESS_STATUS: { minuteGenerated: 'received' } },
  });
  return { rows, enqueue: (eventId = 'event', i = integration) => store.upsertMeetingPipelineTaskForMinuteGenerated({ integration:i, meetingId:'meeting', minuteToken:'minute', eventId }) };
}
test('parallel duplicate arrivals insert once, and owner/attendee remain isolated', async () => {
  const f = taskFixture();
  const result = await Promise.all(Array.from({length:12}, () => f.enqueue()));
  assert.equal(f.rows.length, 1); assert.equal(result.filter(x => x.created).length, 1);
  await f.enqueue('event-attendee', { ...integration, id:'attendee-integration' });
  assert.equal(f.rows.length, 2);
});
test('same meeting with new event ID preserves running lease and every terminal state', async () => {
  const f = taskFixture(); await f.enqueue();
  for (const status of ['running','completed','failed','skipped','blocked','scheduled']) {
    Object.assign(f.rows[0], { status, lockedAt:'keep-lock', nextRunAt:'keep-time', attemptCount:2 });
    const before = JSON.stringify(f.rows[0]);
    assert.equal((await f.enqueue('different-event')).duplicate, true);
    assert.equal(JSON.stringify(f.rows[0]), before);
  }
});

function processorFixture(gate) {
  const source = fs.readFileSync('src/lib/feishu/pipeline/meetingPipelineProcessor.ts', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions:{ module:ts.ModuleKind.CommonJS } }).outputText;
  const mocks = Object.fromEntries([...compiled.matchAll(/require\("([^"]+)"\)/g)].map(m => [m[1], {}]));
  const updates = [], audits = [], logs = [];
  const task = { id:'task', integrationId:integration.id, feishuMeetingId:'meeting', minuteToken:'minute', status:'running', lockedAt:new Date(), startedAt:new Date(), attemptCount:0, payload:{} };
  let enqueues = 0, eligibilityCalls = 0;
  Object.assign(mocks, {
    '@/lib/platform/serverRuntime': { assertServerRuntimeEnabled() {} },
    '../common/monitor': { logFeishuMonitor: (...args) => logs.push(args), toErrorContext: () => ({}) },
    '../common/openapi': { FeishuOpenApiError:ApiError },
    '../minutes/minuteInfo': { MinuteInfoError },
    '../integration/integrationActivationService': { async isFeishuIntegrationActive() { return true; } },
    '../integration/integrationStore': { async getFeishuIntegrationContextById() { return integration; }, async writeAuditLog(data) { audits.push(data); } },
    './meetingEligibility': { async evaluateMeetingEligibility() { eligibilityCalls++; if (gate instanceof MinuteInfoError || gate instanceof Error) throw gate; return gate; } },
    './status': { FEISHU_PROCESS_STATUS: { checkingEligibility:'checking', gatedSkipped:'skipped', fetchingTranscript:'transcript' } },
    './meetingPipelineTaskStore': {
      async getMeetingPipelineTaskByEventId() { return null; },
      async upsertMeetingPipelineTaskForMinuteGenerated() { enqueues++; return {task,created:true,duplicate:false}; },
      async getMeetingPipelineTaskById() { return task; },
      async updateMeetingPipelineTask(id, update) { updates.push(update); },
      async scheduleMeetingPipelineTask(id, update) { updates.push({status:'scheduled',...update}); },
      async failMeetingPipelineTask(id, update) { updates.push({status:'failed',...update}); },
      async listRecoverableMeetingPipelineTasks() { return [task]; },
    },
  });
  const processor = load('src/lib/feishu/pipeline/meetingPipelineProcessor.ts', mocks, {
    process: {env:{}}, setTimeout() { throw new Error('Startup must not launch tasks outside the worker'); },
  });
  return { processor, task, updates, audits, logs, counts: () => ({enqueues,eligibilityCalls}) };
}
test('event is persisted before any title, owner, Base or analysis lookup', async () => {
  const f = processorFixture();
  await f.processor.enqueueFeishuEvent({ header:{event_id:'event',event_type:'minutes.minute.generated_v1'}, event:{minute_token:'minute',minute_source:{source_type:'meeting',source_entity_id:'meeting'}} }, integration);
  assert.deepEqual(f.counts(), {enqueues:1,eligibilityCalls:0});
});
test('blocked and skipped tasks do not create report rows or delivery tasks', async () => {
  for (const [status, reasonCode] of [['blocked','minute_read_forbidden'],['skipped','minute_not_owner'],['skipped','meeting_topic_keyword_mismatch']]) {
    const f = processorFixture({allowed:false,status,reasonCode,message:'classified result'});
    await f.processor.runMeetingPipelineTask('task');
    assert.equal(f.updates.at(-1).status, status);
    assert.equal(f.updates.at(-1).lockedAt, null);
    assert.equal(f.logs.filter(x => x[0] === 'error').length, 0);
    assert.equal(f.logs.filter(x => x[1] === 'meeting_event_not_analyzed').length, 1);
    assert.equal(f.audits.length, 1);
  }
});
test('preparation failures persist bounded retries at eligibility stage', async () => {
  const f = processorFixture(new MinuteInfoError('minute_not_ready','wait',true));
  await f.processor.runMeetingPipelineTask('task');
  assert.equal(f.updates.at(-1).status,'scheduled');
  assert.equal(f.updates.at(-1).currentStage,'checking');
  f.task.attemptCount=2;
  await f.processor.runMeetingPipelineTask('task');
  assert.equal(f.updates.at(-1).status,'failed');
});
test('startup is observation-only; terminal/unclaimed tasks cannot execute', async () => {
  const f = processorFixture();
  await f.processor.recoverFeishuMeetingPipelinesOnStartup();
  f.task.status='blocked'; await f.processor.runMeetingPipelineTask('task');
  f.task.status='running'; f.task.lockedAt=null; await f.processor.runMeetingPipelineTask('task');
  assert.equal(f.counts().eligibilityCalls,0);
});
