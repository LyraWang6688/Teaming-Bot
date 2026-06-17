/**
 * 飞书初始化 API
 * 接收 App ID 和 App Secret，启动授权流程
 */

import { NextRequest, NextResponse } from 'next/server';
import { startDeviceAuth } from '@/lib/feishu/client';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { appId, appSecret } = body;

    // 验证输入
    if (!appId || !appSecret) {
      return NextResponse.json(
        { error: 'App ID 和 App Secret 不能为空' },
        { status: 400 }
      );
    }

    // 验证 App ID 格式
    if (!appId.startsWith('cli_')) {
      return NextResponse.json(
        { error: 'App ID 格式不正确，应以 cli_ 开头' },
        { status: 400 }
      );
    }

    console.log(`[Feishu Init] 开始初始化，App ID: ${appId}`);

    // 启动 Device Flow 授权（内部会初始化配置）
    let authResult;
    try {
      authResult = await startDeviceAuth(appId, appSecret);
      console.log('[Feishu Init] Device Flow 启动成功');
    } catch (error: any) {
      console.error('[Feishu Init] Device Flow 启动失败:', error);
      return NextResponse.json(
        { error: '启动授权流程失败: ' + error.message },
        { status: 500 }
      );
    }

    // 返回授权信息
    return NextResponse.json({
      success: true,
      deviceCode: authResult.deviceCode,
      authUrl: authResult.verificationUrl,
      userCode: authResult.userCode,
      expiresIn: authResult.expiresIn,
    });

  } catch (error: any) {
    console.error('[Feishu Init] 初始化失败:', error);
    return NextResponse.json(
      { error: error.message || '初始化失败' },
      { status: 500 }
    );
  }
}
