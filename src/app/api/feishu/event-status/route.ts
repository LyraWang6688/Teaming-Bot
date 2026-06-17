/**
 * 获取事件监听服务状态 API
 * GET /api/feishu/event-status
 *
 * @deprecated 当前正式飞书链路已切换为 Webhook + OpenAPI，
 * 旧版 listener + CLI 仅保留作历史参考，不再建议使用。
 */

import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      deprecated: true,
      message: '该接口已废弃。当前正式方案为 Webhook + OpenAPI，请通过部署日志、Webhook 回调和多维表格状态排查运行情况。',
    },
    { status: 410 }
  );
}
