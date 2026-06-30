import { NextRequest, NextResponse } from 'next/server';
import { initializeFeishuIntegrationBase } from '@/lib/feishu/integration/integrationSetup';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getCurrentUser } from '@/lib/auth/session';
import { getRequestTraceContext } from '@/lib/platform/requestTrace';

type RouteContext = {
  params: Promise<{
    integrationId: string;
  }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const traceContext = getRequestTraceContext(request);
  const user = await getCurrentUser();
  if (!user) {
    logRuntimeMonitor('warn', 'integration_base', 'integration_base_initialize_rejected_unauthenticated', traceContext);
    return NextResponse.json(
      { success: false, error: '请先登录后再初始化 Base。' },
      { status: 401 }
    );
  }

  const { integrationId } = await context.params;
  try {
    logRuntimeMonitor('info', 'integration_base', 'integration_base_initialize_started', {
      ...traceContext,
      userId: user.id,
      integrationId,
    });

    const result = await initializeFeishuIntegrationBase({
      userId: user.id,
      integrationId,
      setupTraceId: traceContext.setupTraceId,
    });

    logRuntimeMonitor('info', 'integration_base', 'integration_base_initialize_completed', {
      ...traceContext,
      userId: user.id,
      integrationId,
      appToken: result.appToken,
      tableId: result.tableId,
      createdApp: result.createdApp,
      createdTable: result.createdTable,
      createdFieldCount: result.createdFields.length,
    });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logRuntimeMonitor('error', 'integration_base', 'integration_base_initialize_failed', {
      ...traceContext,
      userId: user.id,
      integrationId,
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '初始化 Base 失败。' },
      { status: 500 }
    );
  }
}
