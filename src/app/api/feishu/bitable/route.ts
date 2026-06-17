import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  void request;

  return NextResponse.json(
    {
      error: '该接口已废弃。当前正式飞书接入方案改为手工准备 Base，并通过 FEISHU_BASE_APP_TOKEN 与 FEISHU_MEETING_TABLE_ID 注入运行时配置。',
    },
    { status: 410 }
  );
}
