import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getAppRegistrationTask } from '@/lib/feishu/integration/appRegistrationStore';
import { finalizeAppRegistration } from '@/lib/feishu/integration/appRegistrationService';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getRequestTraceContext } from '@/lib/platform/requestTrace';

export async function POST(request: Request) {
  const startedAt = Date.now();
  const traceContext = getRequestTraceContext(request);
  let sessionToken = '';

  try {
    const body = (await request.json().catch(() => null)) as { sessionToken?: string } | null;
    sessionToken = body?.sessionToken?.trim() || '';
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: '缺少 sessionToken' }, { status: 400 });
    }

    const task = getAppRegistrationTask(sessionToken);
    if (!task) {
      return NextResponse.json({
        success: true,
        data: { status: 'expired', error: '创建应用会话已过期，请重新发起。' },
      });
    }

    const currentUser = await getCurrentUser();
    if (!currentUser || currentUser.id !== task.userId) {
      return NextResponse.json({ success: false, error: '创建应用会话不属于当前用户。' }, { status: 403 });
    }

    if (task.status === 'completed') {
      const integration = await finalizeAppRegistration(sessionToken);
      if (integration) {
        logRuntimeMonitor('info', 'feishu_sdk_setup', 'register_poll_completed', {
          ...traceContext,
          stage: 'register_poll',
          integrationId: integration.id,
          userId: task.userId,
          durationMs: Date.now() - startedAt,
        });
        return NextResponse.json({
          success: true,
          data: { status: 'completed', integrationId: integration.id, integration },
        });
      }
    }

    const refreshedTask = getAppRegistrationTask(sessionToken);
    if (refreshedTask?.status === 'finalized' && refreshedTask.integrationId) {
      return NextResponse.json({
        success: true,
        data: { status: 'completed', integrationId: refreshedTask.integrationId },
      });
    }

    const publicStatus = refreshedTask?.status === 'starting' || refreshedTask?.status === 'finalizing'
      ? 'pending'
      : refreshedTask?.status || 'expired';
    return NextResponse.json({
      success: true,
      data: { status: publicStatus, error: refreshedTask?.error || undefined },
    });
  } catch (error) {
    logRuntimeMonitor('error', 'feishu_sdk_setup', 'register_poll_failed', {
      ...traceContext,
      stage: 'register_poll',
      sessionToken,
      durationMs: Date.now() - startedAt,
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '读取创建状态失败' },
      { status: 500 }
    );
  }
}
