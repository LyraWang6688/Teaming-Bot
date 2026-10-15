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
 *   · `version` ← package.json，构建时就打进去了
 *   · `commit`  ← 环境变量 `GIT_COMMIT`（部署脚本注入；没配就返回 null）
 *   · `startedAt` ← 进程启动时刻，用于判断"是不是刚重启过"
 */
import { NextResponse } from 'next/server';

import pkg from '../../../../package.json';

/** 进程启动时刻。模块只在进程首次加载时求值一次。 */
const STARTED_AT = new Date();

export async function GET() {
  const commit = process.env.GIT_COMMIT || null;

  return NextResponse.json(
    {
      ok: true,
      service: 'teaming-bot',
      version: pkg.version,
      commit,
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
