import { NextRequest, NextResponse } from 'next/server';
import { runFeishuIntegrationChecks } from '@/lib/feishu/integration/integrationSetup';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getCurrentUser } from '@/lib/auth/session';

type RouteContext = {
  params: Promise<{
    integrationId: string;
  }>;
};

export async function POST(_request: NextRequest, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    logRuntimeMonitor('warn', 'integration_checks', 'integration_checks_rejected_unauthenticated');
    return NextResponse.json(
      { success: false, error: '请先登录后再执行飞书真实检查。' },
      { status: 401 }
    );
  }

  const { integrationId } = await context.params;
  try {
    const result = await runFeishuIntegrationChecks({
      userId: user.id,
      integrationId,
    });

    logRuntimeMonitor('info', 'integration_checks', 'integration_checks_completed', {
      userId: user.id,
      integrationId,
      allPassed: result.allPassed,
      statuses: result.statuses,
    });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logRuntimeMonitor('error', 'integration_checks', 'integration_checks_failed', {
      userId: user.id,
      integrationId,
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '执行真实检查失败。' },
      { status: 500 }
    );
  }
}
