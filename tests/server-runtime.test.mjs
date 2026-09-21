import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(env) {
  const source = fs.readFileSync('src/lib/platform/serverRuntime.ts', 'utf8');
  const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const context = { exports: {}, process: { env } };
  vm.runInNewContext(out, { ...context, URL });
  return context.exports;
}
test('development stays disabled even if flag accidentally enabled', () => {
  const runtime = load({ NODE_ENV: 'development', FEISHU_RUNTIME_ENABLED: 'true' });
  assert.equal(runtime.isServerRuntimeEnabled(), false);
  assert.throws(() => runtime.assertServerRuntimeEnabled(), /SERVER_RUNTIME_DISABLED/);
});
test('production requires explicit opt-in', () => {
  assert.equal(load({ NODE_ENV: 'production' }).isServerRuntimeEnabled(), false);
  assert.equal(load({ NODE_ENV: 'production', FEISHU_RUNTIME_ENABLED: 'true' }).isServerRuntimeEnabled(), true);
});
test('report URL validation rejects local, malformed, credential and non-HTTPS addresses', () => {
  const runtime = load({});
  for (const url of ['http://localhost:5000/report/x', 'https://localhost/report/x', 'https://127.0.0.1/report/x', 'https://[::1]/report/x', 'https://preview.local/report/x', 'https://preview.localhost/report/x', 'https://user:secret@example.com/report/x', 'http://meeting.bamamei.online/report/x', 'not-a-url']) {
    assert.throws(() => runtime.assertPublicReportUrl(url), /INVALID_REPORT_URL/);
  }
  assert.equal(runtime.assertPublicReportUrl('https://meeting.bamamei.online/report/v2/example').origin, 'https://meeting.bamamei.online');
});
