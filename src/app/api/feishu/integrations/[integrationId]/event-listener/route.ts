import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getUserFeishuIntegrationContext } from '@/lib/feishu/integration/integrationStore';
import {
  getListenerStartFailureContext,
  getListenerStatus,
  startListener,
} from '@/lib/feishu/events/eventListenerManager';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

type RouteContext = { params: Promise<{ integrationId: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ success: false, error: '请先登录' }, { status: 401 });
  }

  const { integrationId } = await context.params;
  const integration = await getUserFeishuIntegrationContext(user.id, integrationId);
  if (!integration) {
    return NextResponse.json({ success: false, error: '未找到集成' }, { status: 404 });
  }

  const status = getListenerStatus(integrationId);

  return NextResponse.json({
    success: true,
    data: {
      status: status?.state || 'stopped',
      lastError: status?.lastError || null,
      startedAt: status?.startedAt?.toISOString() || null,
      readyAt: status?.readyAt?.toISOString() || null,
    },
  });
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ success: false, error: '请先登录' }, { status: 401 });
  }

  const { integrationId } = await context.params;
  const integration = await getUserFeishuIntegrationContext(user.id, integrationId);
  if (!integration) {
    return NextResponse.json({ success: false, error: '未找到集成' }, { status: 404 });
  }

  try {
    logRuntimeMonitor('info', 'feishu_event_listener', 'event_listener_manual_start_started', {
      stage: 'manual_start_listener',
      integrationId,
      userId: user.id,
    });

    const listener = await startListener(integrationId);

    logRuntimeMonitor('info', 'feishu_event_listener', 'event_listener_manual_start_completed', {
      stage: 'manual_start_listener',
      integrationId,
      userId: user.id,
      listenerStatus: listener.state,
      readyAt: listener.readyAt?.toISOString() || null,
    });

    return NextResponse.json({
      success: true,
      data: {
        status: listener.state,
        readyAt: listener.readyAt?.toISOString() || null,
      },
    });
  } catch (error) {
    logRuntimeMonitor('error', 'feishu_event_listener', 'event_listener_manual_start_failed', {
      stage: 'manual_start_listener',
      integrationId,
      userId: user.id,
      ...getListenerStartFailureContext(error),
      ...toRuntimeErrorContext(error),
    });

    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '启动监听失败' },
      { status: 500 }
    );
  }
}
