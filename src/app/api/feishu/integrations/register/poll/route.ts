import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { findOrCreateUserByFeishu } from '@/lib/auth/userStore';
import { createSession } from '@/lib/auth/session';
import { createUserFeishuIntegration } from '@/lib/feishu/integration/integrationStore';
import { getProcess, deleteProcess } from '@/lib/feishu/cliProcessStore';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getRequestTraceContext } from '@/lib/platform/requestTrace';

function getElapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const traceContext = getRequestTraceContext(request);
  let sessionToken: string | undefined;
  let profileName: string | undefined;

  try {
    const body = await request.json();
    sessionToken = body.sessionToken;
    const reqProfileName = body.profileName;

    if (!sessionToken) {
      return NextResponse.json(
        { success: false, error: '缺少 sessionToken' },
        { status: 400 }
      );
    }

    const entry = getProcess(sessionToken);
    if (!entry) {
      logRuntimeMonitor('warn', 'feishu_cli_setup', 'register_poll_expired', {
        ...traceContext,
        stage: 'register_poll',
        sessionToken,
        durationMs: getElapsedMs(startedAt),
      });
      return NextResponse.json({
        success: true,
        data: { status: 'expired', error: '会话已过期，请重新创建应用' },
      });
    }

    profileName = reqProfileName || entry.profileName;
    const { child } = entry;

    logRuntimeMonitor('info', 'feishu_cli_setup', 'register_poll_started', {
      ...traceContext,
      stage: 'register_poll',
      sessionToken,
      profileName,
      exitCode: child.exitCode,
      killed: child.killed,
    });

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
      logRuntimeMonitor('error', 'feishu_cli_setup', 'register_poll_cli_failed', {
        ...traceContext,
        stage: 'register_poll',
        sessionToken,
        profileName,
        durationMs: getElapsedMs(startedAt),
        exitCode: child.exitCode,
        stderr: entry.stderrBuffer.slice(0, 2000),
      });
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
    let appSecret: string;
    try {
      const parsed = JSON.parse(stdout);
      const payload = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
      appId = payload.appId;
      appSecret = payload.appSecret || payload.app_secret;
      if (!appId) throw new Error('缺少 appId');
      if (!appSecret) throw new Error('缺少 appSecret');
    } catch {
      logRuntimeMonitor('error', 'feishu_cli_setup', 'register_poll_parse_failed', {
        ...traceContext,
        stage: 'register_poll',
        sessionToken,
        profileName,
        durationMs: getElapsedMs(startedAt),
        stdout: stdout.slice(0, 2000),
      });
      deleteProcess(sessionToken);
      return NextResponse.json({
        success: true,
        data: { status: 'error', error: '无法解析 CLI 输出' },
      });
    }

    const existingUser = await getCurrentUser();
    let user = existingUser;
    let placeholderOpenId: string | null = null;

    // If the user has not logged in yet, create a temporary local user. The
    // authorize step replaces this pending open_id with the real Feishu open_id.
    if (!existingUser) {
      placeholderOpenId = `pending-${sessionToken}`;
      const created = await findOrCreateUserByFeishu({
        openId: placeholderOpenId,
        name: `用户-${sessionToken}`,
      });
      user = {
        id: created.user.id,
        feishuOpenId: created.user.feishuOpenId,
        name: created.user.feishuName,
        email: created.user.feishuEmail,
        avatarUrl: created.user.feishuAvatarUrl,
      };
      await createSession(created.user.id);
    }

    if (!user) {
      throw new Error('创建用户会话失败');
    }

    const integration = await createUserFeishuIntegration({
      userId: user.id,
      name: `Teaming-Bot-${sessionToken}`,
      appId,
      appSecret,
      profileName,
      oauthScope: 'minutes:minutes.basic:read minutes:minutes.transcript:export offline_access bitable:app',
    });

    logRuntimeMonitor('info', 'feishu_cli_setup', 'register_poll_completed', {
      ...traceContext,
      stage: 'register_poll',
      integrationId: integration.id,
      appId,
      profileName,
      userId: user.id,
      durationMs: getElapsedMs(startedAt),
    });

    deleteProcess(sessionToken);

    return NextResponse.json({
      success: true,
      data: {
        status: 'completed',
        integration,
        user: { id: user.id, feishuOpenId: user.feishuOpenId || placeholderOpenId },
      },
    });
  } catch (error) {
    logRuntimeMonitor('error', 'feishu_cli_setup', 'register_poll_failed', {
      ...traceContext,
      stage: 'register_poll',
      sessionToken,
      profileName,
      durationMs: getElapsedMs(startedAt),
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '轮询创建状态失败' },
      { status: 500 }
    );
  }
}
