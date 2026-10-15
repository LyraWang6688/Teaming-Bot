/**
 * 健康检查接口。
 *
 * 它的唯一用途是让"生产在跑哪个版本"一眼可见。所以测试盯的是
 * **版本信息必须真实**——这个接口如果撒谎（比如硬编码版本号、
 * 或者缓存住了旧值），那它比没有更糟：人会信它。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const ROUTE_PATH = 'src/app/api/health/route.ts';

function loadHealth({ env = {}, pkgVersion = '9.9.9' } = {}) {
  const code = ts.transpileModule(fs.readFileSync(ROUTE_PATH, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const exportsObj = {};
  vm.runInNewContext(code, {
    exports: exportsObj,
    require(name) {
      if (name === 'next/server') {
        return {
          NextResponse: {
            json: (body, init) => ({
              status: init?.status ?? 200,
              headers: init?.headers ?? {},
              body,
            }),
          },
        };
      }
      if (name.endsWith('package.json')) {
        return { version: pkgVersion, name: 'teaming-bot' };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { ...process, env: { ...process.env, ...env } },
    console,
    Date,
    Error,
    JSON,
    Math,
  });
  return exportsObj;
}

test('返回的版本号来自 package.json，不是写死的', async () => {
  const { GET } = loadHealth({ pkgVersion: '3.2.1' });
  const res = await GET();
  assert.equal(res.status, 200);
  assert.equal(res.body.version, '3.2.1');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.service, 'teaming-bot');
});

test('★ 真实 package.json 的版本就是当前发布版本', async () => {
  const real = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const { GET } = loadHealth({ pkgVersion: real.version });
  const res = await GET();
  assert.equal(res.body.version, real.version);
  // 发布版本必须是语义化的 X.Y.Z —— tag、Release、健康检查都依赖它对齐
  assert.match(real.version, /^\d+\.\d+\.\d+$/, 'package.json 的 version 应是 X.Y.Z');
});

test('commit 来自 GIT_COMMIT 环境变量', async () => {
  const withCommit = loadHealth({ env: { GIT_COMMIT: 'abc1234' } });
  assert.equal((await withCommit.GET()).body.commit, 'abc1234');

  const without = loadHealth({ env: { GIT_COMMIT: '' } });
  assert.equal((await without.GET()).body.commit, null, '没配就是 null，不要编一个假值');
});

test('★ 不能被缓存——否则部署完还看到旧版本', async () => {
  const { GET } = loadHealth();
  const res = await GET();
  const cacheControl = String(res.headers['Cache-Control'] || '');
  assert.match(cacheControl, /no-store/, '必须显式 no-store，否则 CDN/浏览器会缓存住旧版本');
});

test('startedAt 与 uptimeSeconds 自洽', async () => {
  const { GET } = loadHealth();
  const res = await GET();
  const started = new Date(res.body.startedAt);
  assert.ok(!Number.isNaN(started.getTime()), 'startedAt 应是合法时间');
  assert.ok(started.getTime() <= Date.now(), 'startedAt 不能在未来');
  assert.ok(Number.isInteger(res.body.uptimeSeconds));
  assert.ok(res.body.uptimeSeconds >= 0);
});
