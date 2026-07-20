import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import {
  getUserFeishuIntegrationContext,
  upsertFeishuIntegrationCheckStatus,
} from '@/lib/feishu/integration/integrationStore';
import { getListenerStartFailureContext, startListener } from '@/lib/feishu/events/eventListenerManager';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getRequestTraceContext } from '@/lib/platform/requestTrace';

type RouteContext = { params: Promise<{ integrationId: string }> };

function getElapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const startedAt = Date.now();
  const traceContext = getRequestTraceContext(request);
  let integrationId = '';
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ success: false, error: '请先登录' }, { status: 401 });
  }

  try {
    integrationId = (await context.params).integrationId;
    const integration = await getUserFeishuIntegrationContext(user.id, integrationId);
    if (!integration) {
      return NextResponse.json({ success: false, error: '未找到集成配置' }, { status: 404 });
    }

    logRuntimeMonitor('info', 'feishu_event_subscription', 'event_subscription_check_started', {
      ...traceContext,
      stage: 'event_subscription_check',
      integrationId,
      userId: user.id,
    });

    const listener = await startListener(integrationId);

    await upsertFeishuIntegrationCheckStatus({
      integrationId,
      eventSubscriptionStatus: 'success',
      lastErrorType: null,
      lastErrorMessage: null,
      details: {
        eventKey: 'minutes.minute.generated_v1',
        provider: 'node_sdk_ws',
        listenerStatus: listener.state,
        readyAt: listener.readyAt?.toISOString() || null,
      },
    });

    logRuntimeMonitor('info', 'feishu_event_subscription', 'event_subscription_check_completed', {
      ...traceContext,
      stage: 'event_subscription_check',
      integrationId,
      userId: user.id,
      listenerStatus: listener.state,
      readyAt: listener.readyAt?.toISOString() || null,
      durationMs: getElapsedMs(startedAt),
    });

    return NextResponse.json({
      success: true,
      data: {
        eventFound: true,
        eventKey: 'minutes.minute.generated_v1',
        status: listener.state,
      },
    });
  } catch (error) {
    logRuntimeMonitor('error', 'feishu_event_subscription', 'event_subscription_check_failed', {
      ...traceContext,
      stage: 'event_subscription_check',
      integrationId,
      userId: user.id,
      durationMs: getElapsedMs(startedAt),
      ...getListenerStartFailureContext(error),
      ...toRuntimeErrorContext(error),
    });

    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '事件监听校验失败' },
      { status: 500 }
    );
  }
}
