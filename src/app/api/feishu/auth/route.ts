/**
 * 飞书授权状态检查 API
 * 检查用户是否已完成授权
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAuthStatus, getAuthStatus } from '@/lib/feishu/client';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { deviceCode } = body;

    if (!deviceCode) {
      return NextResponse.json(
        { error: 'Device Code 不能为空' },
        { status: 400 }
      );
    }

    console.log(`[Feishu Auth] 检查授权状态，Device Code: ${deviceCode.substring(0, 10)}...`);

    // 尝试完成授权
    const authResult = await checkAuthStatus(deviceCode);

    if (authResult.success && authResult.user) {
      console.log(`[Feishu Auth] 授权成功，用户: ${authResult.user.userName}`);
      
      // 获取完整的授权状态
      const status = await getAuthStatus();
      
      return NextResponse.json({
        status: 'success',
        user: authResult.user,
        appId: status.appId,
      });
    }

    // 授权还在等待中
    console.log('[Feishu Auth] 授权等待中...');
    return NextResponse.json({
      status: 'pending',
      message: '等待用户完成授权',
    });

  } catch (error: any) {
    console.error('[Feishu Auth] 检查授权状态失败:', error);
    
    // 检查是否是等待中的错误
    if (error.message?.includes('pending') || error.message?.includes('waiting')) {
      return NextResponse.json({
        status: 'pending',
        message: '等待用户完成授权',
      });
    }

    return NextResponse.json(
      { status: 'error', error: error.message || '检查授权状态失败' },
      { status: 500 }
    );
  }
}
