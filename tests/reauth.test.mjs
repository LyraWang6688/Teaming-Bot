import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import nodeCrypto from 'node:crypto';

function load(path, mocks, extra = {}) {
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, Date, URL, URLSearchParams, console, Buffer, Number, JSON, Math, isNaN, NumberisFinite: Number.isFinite,
    require(name) { if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`); return mocks[name]; },
    ...extra,
  });
  return exports;
}

// ---------- reauthToken ----------
const tokenModule = load('src/lib/feishu/integration/reauthToken.ts', {
  'node:crypto': nodeCrypto,
  '@/lib/platform/env': { getAppEncryptionKey: () => 'test-encryption-key' },
});

test('reauth token roundtrip succeeds', () => {
  const now = Date.now();
  const token = tokenModule.createReauthToken('integration-1', now);
  assert.equal(tokenModule.verifyReauthToken(token, now)?.integrationId, 'integration-1');
});

test('reauth token rejects tampered payload and signature', () => {
  const now = Date.now();
  const token = tokenModule.createReauthToken('integration-1', now);
  const [payload, signature] = token.split('.');
  const forgedPayload = Buffer.from('integration-2.9999999999999').toString('base64url');
  assert.equal(tokenModule.verifyReauthToken(`${forgedPayload}.${signature}`, now), null);
  assert.equal(tokenModule.verifyReauthToken(`${payload}.${signature.slice(0, -2)}aa`, now), null);
  assert.equal(tokenModule.verifyReauthToken('garbage', now), null);
  assert.equal(tokenModule.verifyReauthToken('', now), null);
});

test('reauth token rejects expired tokens', () => {
  const now = Date.now();
  const token = tokenModule.createReauthToken('integration-1', now - 8 * 24 * 60 * 60 * 1000);
  assert.equal(tokenModule.verifyReauthToken(token, now), null);
});

test('reauth token depends on encryption key', () => {
  const otherModule = load('src/lib/feishu/integration/reauthToken.ts', {
    'node:crypto': nodeCrypto,
    '@/lib/platform/env': { getAppEncryptionKey: () => 'another-key' },
  });
  const now = Date.now();
  const token = otherModule.createReauthToken('integration-1', now);
  assert.equal(tokenModule.verifyReauthToken(token, now), null);
});

// ---------- reauthShared ----------
const shared = load('src/lib/feishu/pipeline/reauthShared.ts', {});

test('isReauthorizationGateReason covers oauth_* and legacy reason', () => {
  assert.equal(shared.isReauthorizationGateReason('oauth_refresh_token_expired'), true);
  assert.equal(shared.isReauthorizationGateReason('oauth_not_authorized'), true);
  assert.equal(shared.isReauthorizationGateReason('integration_authorization_invalid'), true);
  assert.equal(shared.isReauthorizationGateReason('minute_read_forbidden'), false);
  assert.equal(shared.isReauthorizationGateReason('meeting_topic_keyword_mismatch'), false);
  assert.equal(shared.isReauthorizationGateReason(null), false);
  assert.equal(shared.isReauthorizationGateReason(undefined), false);
});

test('isWithinResumeWindow honors the 85-day window with fallback', () => {
  const now = Date.parse('2026-09-30T00:00:00.000Z');
  const day = 24 * 60 * 60 * 1000;
  assert.equal(shared.isWithinResumeWindow(new Date(now - 84 * day).toISOString(), new Date(0), now), true);
  assert.equal(shared.isWithinResumeWindow(new Date(now - 86 * day).toISOString(), new Date(0), now), false);
  assert.equal(shared.isWithinResumeWindow(null, new Date(now - 10 * day), now), true);
  assert.equal(shared.isWithinResumeWindow('not-a-date', new Date(now - 100 * day), now), false);
});

test('formatReminderEventDate renders Beijing date and falls back to now', () => {
  const rendered = shared.formatReminderEventDate('2026-09-29T16:00:00.000Z');
  assert.match(rendered, /2026/);
  assert.match(rendered, /9|09/);
  assert.match(rendered, /30/);
  assert.ok(shared.formatReminderEventDate(null, new Date('2026-09-30T00:00:00.000Z')).length > 0);
});

// ---------- meetingEligibility 授权失效 → blocked ----------
class MockAuthError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'FeishuAuthorizationError'; }
}
class MockMinuteInfoError extends Error {
  constructor(code, message, retryable) { super(message); this.code = code; this.retryable = retryable; }
}

function loadEligibility({ detailsError, minuteError } = {}) {
  return load('src/lib/feishu/pipeline/meetingEligibility.ts', {
    '../integration/integrationStore': {
      async getLatestFeishuAuthorizationContext() {
        return { status: 'authorized', authorizedOpenId: 'owner-open-id' };
      },
    },
    '../integration/tokenService': { FeishuAuthorizationError: MockAuthError },
    '../meetings/meetingDetailsService': {
      async fetchMeetingDetails() {
        if (detailsError) throw detailsError;
        return { meetingId: 'm-1', topic: 'ABC 周会', organizerOpenId: null, hostOpenId: null };
      },
    },
    '../meetings/meetingDetailsTypes': {},
    '../minutes/minuteInfo': {
      async fetchMinuteInfo() {
        if (minuteError) throw minuteError;
        return { token: 't', ownerId: 'owner-open-id', title: null, createTime: null, duration: null, url: null, noteId: null };
      },
      MinuteInfoError: MockMinuteInfoError,
    },
  });
}

const integration = { id: 'int-1', appId: 'app-1', initializedAt: '2026-09-01', selectedOrgTargetId: 'org-1' };

test('meeting details auth failure becomes blocked oauth_* gate', async () => {
  const gate = loadEligibility({ detailsError: new MockAuthError('refresh_token_expired', '飞书持续授权已过期，请重新授权后再继续。') });
  const result = await gate.evaluateMeetingEligibility(integration, 'm-1', 't-1');
  assert.equal(result.allowed, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'oauth_refresh_token_expired');
});

test('minute read auth failure becomes blocked oauth_* gate', async () => {
  const gate = loadEligibility({ minuteError: new MockAuthError('refresh_failed', '飞书授权已失效且自动续期失败，请重新授权后再继续。') });
  const result = await gate.evaluateMeetingEligibility(integration, 'm-1', 't-1');
  assert.equal(result.allowed, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'oauth_refresh_failed');
});

test('non-auth errors still propagate and normal path still works', async () => {
  const gate = loadEligibility({ minuteError: new Error('network down') });
  await assert.rejects(() => gate.evaluateMeetingEligibility(integration, 'm-1', 't-1'), /network down/);
  const ok = loadEligibility();
  const result = await ok.evaluateMeetingEligibility(integration, 'm-1', 't-1');
  assert.equal(result.allowed, true);
});
