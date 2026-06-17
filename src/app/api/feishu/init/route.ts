import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  void request;

  return NextResponse.json(
    {
      error: '该接口已废弃。当前正式飞书接入方案为 Webhook + OpenAPI + 服务器环境变量，不再支持前端触发 CLI Device Flow 初始化。',
    },
    { status: 410 }
  );
}
