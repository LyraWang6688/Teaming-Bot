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

test('commit 来源：GIT_COMMIT 优先，其次用镜像烘进去的 APP_REVISION', async () => {
  // 运行时注入优先（热修 / 不重建的部署）
  const runtimeWins = loadHealth({ env: { GIT_COMMIT: 'abc1234', APP_REVISION: 'def5678' } });
  assert.equal((await runtimeWins.GET()).body.commit, 'abc1234');

  // ★ 关键回归：Dockerfile 早就在设 APP_REVISION，而接口只读过 GIT_COMMIT，
  // 于是「镜像明明带着提交号、接口却报 null」——两个原因叠在一起，很难发现。
  // 这条守住不再犯。
  const fromImage = loadHealth({ env: { GIT_COMMIT: '', APP_REVISION: 'def5678' } });
  assert.equal((await fromImage.GET()).body.commit, 'def5678');

  const neither = loadHealth({ env: { GIT_COMMIT: '', APP_REVISION: '' } });
  assert.equal((await neither.GET()).body.commit, null, '没配就是 null，不要编一个假值');
});

test('★ "unknown" 不能当提交号报出去——那是「未知」，不是版本', async () => {
  // Dockerfile 里 SOURCE_REVISION 的默认值就是 unknown。
  // 把它当版本号返回等于用「未知」冒充「已知」，比 null 更误导。
  const res = await loadHealth({ env: { GIT_COMMIT: '', APP_REVISION: 'unknown' } }).GET();
  assert.equal(res.body.commit, null);
  assert.equal(res.body.imageRevision, null);

  // 大小写和前后空格也不该让它漏过去
  const weird = await loadHealth({ env: { GIT_COMMIT: '  UNKNOWN  ', APP_REVISION: '' } }).GET();
  assert.equal(weird.body.commit, null);
});

test('imageRevision 单独暴露——用来判断镜像本身知不知道自己的提交', async () => {
  const res = await loadHealth({ env: { GIT_COMMIT: 'abc1234', APP_REVISION: 'def5678' } }).GET();
  assert.equal(res.body.commit, 'abc1234', 'commit 是实际生效的那个');
  assert.equal(res.body.imageRevision, 'def5678', 'imageRevision 是镜像自带的那一个');
});

test('★ 部署脚本必须把三个坑堵住（否则这次修复会被改回原样）', () => {
  const script = fs.readFileSync('scripts/deploy.sh', 'utf8');

  // 只看非注释行：脚本头部「为什么要有这个脚本」那段会提到这些命令，
  // 拿整份文件判断顺序会抓到注释，误报。
  const body = script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  assert.match(body, /export SOURCE_REVISION=/, '没传 SOURCE_REVISION，镜像就不知道自己的提交');
  assert.match(body, /--force-recreate/, '不 force-recreate，环境变量不会重新注入');
  assert.match(body, /git pull/, '必须先拉代码');

  // 「先 pull 再 build」这个顺序是 2026-10-15 真实事故的教训：
  // 先构建用了旧代码，容器跑的是前一个提交，日志看不出任何异常。
  assert.ok(
    body.indexOf('git pull') < body.indexOf('docker compose up'),
    'git pull 必须出现在 docker compose up 之前',
  );

  // 部署完要自证，不能只「看起来成功了」
  assert.match(body, /api\/health|HEALTH_URL/, '部署后应读健康接口自证');
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
