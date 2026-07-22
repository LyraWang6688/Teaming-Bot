import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { createSession, getCurrentUser } from '@/lib/auth/session';
import { findOrCreateUserByFeishu, toSafeUser } from '@/lib/auth/userStore';
import { startAppRegistration } from '@/lib/feishu/integration/appRegistrationStore';
import { finalizeAppRegistration } from '@/lib/feishu/integration/appRegistrationService';
import { writeAuditLog } from '@/lib/feishu/integration/integrationStore';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getRequestTraceContext } from '@/lib/platform/requestTrace';

export async function POST(request: Request) {
  const startedAt = Date.now();
  const traceContext = getRequestTraceContext(request);

  try {
    let user = await getCurrentUser();
    if (!user) {
      const pendingId = randomUUID();
      const created = await findOrCreateUserByFeishu({
        openId: `pending-${pendingId}`,
        name: `待授权用户-${pendingId.slice(0, 8)}`,
      });
      await createSession(created.user.id);
      user = toSafeUser(created.user);
    }

    logRuntimeMonitor('info', 'feishu_sdk_setup', 'create_app_started', {
      ...traceContext,
      stage: 'create_app',
      userId: user.id,
    });

    const task = await startAppRegistration(user.id, async (sessionToken) => {
      await finalizeAppRegistration(sessionToken);
    });
    await writeAuditLog({
      userId: user.id,
      action: 'integration.app_registration.started',
      result: 'pending',
      summary: '发起 SDK 一键创建飞书应用',
      metadata: {
        sessionToken: task.sessionToken,
        expiresAt: new Date(task.expiresAt).toISOString(),
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        verificationUrl: task.verificationUrl,
        sessionToken: task.sessionToken,
        expiresAt: new Date(task.expiresAt).toISOString(),
        user,
      },
    });
  } catch (error) {
    logRuntimeMonitor('error', 'feishu_sdk_setup', 'create_app_failed', {
      ...traceContext,
      stage: 'create_app',
      durationMs: Date.now() - startedAt,
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '创建应用失败' },
      { status: 500 }
    );
  }
}
