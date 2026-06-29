import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { findOrCreateUserByFeishu } from '@/lib/auth/userStore';
import { createSession } from '@/lib/auth/session';
import { createUserFeishuIntegration } from '@/lib/feishu/integration/integrationStore';
import { getProcess, deleteProcess } from '@/lib/feishu/cliProcessStore';

export async function POST(request: Request) {
  try {
    const { sessionToken } = await request.json();

    if (!sessionToken) {
      return NextResponse.json(
        { success: false, error: '缺少 sessionToken' },
        { status: 400 }
      );
    }

    const entry = getProcess(sessionToken);
    if (!entry) {
      return NextResponse.json({
        success: true,
        data: { status: 'expired', error: '会话已过期，请重新创建应用' },
      });
    }

    const { child, profileName } = entry;

    // Check if process has exited
    if (child.exitCode === null && child.killed === false) {
      // Still running
      return NextResponse.json({
        success: true,
        data: { status: 'pending' },
      });
    }

    // Process has exited
    if (child.exitCode !== 0) {
      // TODO: read stderr buffer for error details
      deleteProcess(sessionToken);
      return NextResponse.json({
        success: true,
        data: { status: 'error', error: `CLI 进程退出码: ${child.exitCode}，请重试` },
      });
    }

    // Process exited with code 0 — read stored stdout buffer for appId
    // stdout format: {"appId":"cli_xxx","appSecret":"****","brand":"feishu"}
    const stdout = entry.stdoutBuffer;

    let appId: string;
    try {
      const parsed = JSON.parse(stdout);
      appId = parsed.appId;
      if (!appId) throw new Error('缺少 appId');
    } catch {
      deleteProcess(sessionToken);
      return NextResponse.json({
        success: true,
        data: { status: 'error', error: '无法解析 CLI 输出' },
      });
    }

    // Create or find user
    // Note: we use a placeholder openId since the CLI doesn't output it
    // The real user linking happens during the authorize step
    const placeholderOpenId = `pending-${sessionToken}`;
    const { user } = await findOrCreateUserByFeishu({
      openId: placeholderOpenId,
      name: `用户-${sessionToken}`,
    });

    // Create session if not exists
    const existingUser = await getCurrentUser();
    if (!existingUser) {
      await createSession(user.id);
    }

    // Save integration to DB
    // We use a placeholder appSecret since the CLI stores it in keychain
    const integration = await createUserFeishuIntegration({
      userId: user.id,
      name: `Teaming-Bot-${sessionToken}`,
      appId,
      appSecret: 'PLACEHOLDER', // CLI manages the real secret
      profileName,
      oauthScope: 'minutes:minutes.basic:read minutes:minutes.transcript:export offline_access bitable:app',
    });

    console.log('[feishu:register:poll] 应用创建成功', {
      integrationId: integration.id,
      appId,
      profileName,
    });

    deleteProcess(sessionToken);

    return NextResponse.json({
      success: true,
      data: {
        status: 'completed',
        integration,
        user: { id: user.id, feishuOpenId: placeholderOpenId },
      },
    });
  } catch (error) {
    console.error('[feishu:register:poll] 轮询失败', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '轮询创建状态失败' },
      { status: 500 }
    );
  }
}
