/**
 * 健康检查 —— 主要目的是让"生产在跑哪个版本"一眼可见。
 *
 * ## 为什么需要它
 *
 * 在此之前，想知道生产跑的是哪个版本，只能 SSH 上去 `git describe --tags`。
 * 这意味着：出问题时排查的第一步就要登服务器；别人（或未来的自己）打开网址
 * 也看不出线上是什么状态。
 *
 * ## 设计取舍
 *
 * **不查数据库、不查 worker。** 健康检查最常见的误用是把它做成"什么都探一遍"，
 * 于是它自己变成最脆弱的一环。这里只回答两个问题：
 *
 *   1. 进程活着吗（能返回响应本身就是答案）
 *   2. 跑的是哪个版本
 *
 * 数据库与投递链路的健康，由 `integrationHealthWorker` 那条独立通道负责
 * （见 CHANGELOG 的「运维要点」）。
 *
 * ## 版本来源
 *
 *   · `version`       ← package.json，构建时就打进去了
 *   · `commit`        ← 实际生效的提交，见下
 *   · `imageRevision` ← 镜像构建时**烘进镜像**的提交（没烘就是 null）
 *   · `startedAt`     ← 进程启动时刻，用于判断"是不是刚重启过"
 *
 * `commit` 取自两个来源，前者优先：
 *
 *   a. `GIT_COMMIT`   —— 运行时注入，适合热修 / 不走重建的部署
 *   b. `APP_REVISION` —— Dockerfile 在构建时把 `SOURCE_REVISION` 烘进镜像
 *
 * **为什么两个都读**：镜像里那个（b）是"这个镜像自己声称是哪次构建产出的"，
 * 它跟着镜像走，`docker compose up`（不重建）也不会丢；运行时那个（a）允许
 * 临时覆盖。两个都读，就不会再出现"镜像明明带着提交号、接口却报 null"。
 *
 * ⚠️ 2026-10-18 修过的一个真实故障：Dockerfile 早就设了 `APP_REVISION`，
 * 但这里只读 `GIT_COMMIT`，而 compose 从没传过 `SOURCE_REVISION`——于是
 * 接口恒为 null、镜像 label 恒为 unknown，**两个原因叠在一起，谁也不知道**。
 * 现在两处都对：这里读两个变量，部署脚本负责把 `SOURCE_REVISION` 传进去。
 */
import { NextResponse } from 'next/server';

import pkg from '../../../../package.json';

/** 进程启动时刻。模块只在进程首次加载时求值一次。 */
const STARTED_AT = new Date();

/**
 * 这些值等于"不知道"，不能当提交号报出去。
 * `unknown` 是 Dockerfile 里 `SOURCE_REVISION` 的默认值——把它当版本号返回，
 * 等于用"未知"冒充"已知"，比 null 更误导。
 */
const NOT_A_REVISION = new Set(['', 'unknown', 'latest', 'head']);

function normalizeRevision(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  return NOT_A_REVISION.has(trimmed.toLowerCase()) ? null : trimmed;
}

export async function GET() {
  // 镜像烘进去的值：这个镜像自己声称的构建来源
  const imageRevision = normalizeRevision(process.env.APP_REVISION);
  // 实际生效的提交：运行时覆盖优先，否则用镜像自带的值
  const commit = normalizeRevision(process.env.GIT_COMMIT) ?? imageRevision;

  return NextResponse.json(
    {
      ok: true,
      service: 'teaming-bot',
      version: pkg.version,
      commit,
      imageRevision,
      startedAt: STARTED_AT.toISOString(),
      uptimeSeconds: Math.round((Date.now() - STARTED_AT.getTime()) / 1000),
    },
    {
      status: 200,
      // 版本信息不该被 CDN 或浏览器缓存，否则改完部署还看到旧值
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    },
  );
}
