/**
 * 启动事件监听服务 API
 * POST /api/feishu/start-listener
 *
 * @deprecated 当前正式飞书链路已切换为 Webhook + OpenAPI，
 * 旧版 listener + CLI 仅保留作历史参考，不再建议使用。
 */

import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      deprecated: true,
      message: '该接口已废弃。当前正式方案为 Webhook + OpenAPI，请改用 /api/feishu/webhook 接收飞书事件。',
    },
    { status: 410 }
  );
}
