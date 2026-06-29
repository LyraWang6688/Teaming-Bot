import { NextRequest, NextResponse } from 'next/server';
import { initializeFeishuIntegrationBase } from '@/lib/feishu/integration/integrationSetup';
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
    logRuntimeMonitor('warn', 'integration_base', 'integration_base_initialize_rejected_unauthenticated');
    return NextResponse.json(
      { success: false, error: '请先登录后再初始化 Base。' },
      { status: 401 }
    );
  }

  const { integrationId } = await context.params;
  try {
    const result = await initializeFeishuIntegrationBase({
      userId: user.id,
      integrationId,
    });

    logRuntimeMonitor('info', 'integration_base', 'integration_base_initialize_completed', {
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
      userId: user.id,
      integrationId,
      ...toRuntimeErrorContext(error),
    });
    console.error('[feishu:base:initialize] 初始化失败', {
      userId: user.id,
      integrationId,
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '初始化 Base 失败。' },
      { status: 500 }
    );
  }
}
