import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import {
  getLatestFeishuAuthorizationContext,
  getUserFeishuIntegrationContext,
  upsertFeishuIntegrationCheckStatus,
} from '@/lib/feishu/integration/integrationStore';
import { startListener } from '@/lib/feishu/events/eventListenerManager';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getRequestTraceContext } from '@/lib/platform/requestTrace';

type RouteContext = { params: Promise<{ integrationId: string }> };

function getElapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const startedAt = Date.now();
  const traceContext = getRequestTraceContext(request);
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ success: false, error: '请先登录' }, { status: 401 });
  }

  try {
    const { integrationId } = await context.params;
    const integration = await getUserFeishuIntegrationContext(user.id, integrationId);
    if (!integration) {
      return NextResponse.json({ success: false, error: '未找到集成配置' }, { status: 404 });
    }

    logRuntimeMonitor('info', 'feishu_event_subscription', 'event_subscription_check_started', {
      ...traceContext,
      stage: 'event_subscription_check',
      integrationId,
      profileName: integration.profileName,
      userId: user.id,
    });

    if (!integration.profileName) {
      await upsertFeishuIntegrationCheckStatus({
        integrationId,
        eventSubscriptionStatus: 'failed',
        lastErrorType: 'missing_profile',
        lastErrorMessage: '当前集成缺少 CLI profile，无法启动事件监听。',
        details: { eventKey: 'minutes.minute.generated_v1' },
      });

      logRuntimeMonitor('warn', 'feishu_event_subscription', 'event_subscription_check_missing_profile', {
        ...traceContext,
        stage: 'event_subscription_check',
        integrationId,
        userId: user.id,
        durationMs: getElapsedMs(startedAt),
      });

      return NextResponse.json({
        success: true,
        data: {
          eventFound: false,
          status: 'failed',
          error: '当前集成缺少 CLI profile',
        },
      });
    }

    const authorization = await getLatestFeishuAuthorizationContext(integrationId);
    if (!authorization || authorization.status !== 'authorized') {
      await upsertFeishuIntegrationCheckStatus({
        integrationId,
        eventSubscriptionStatus: 'pending',
        lastErrorType: 'authorization_required',
        lastErrorMessage: '请先完成飞书用户授权。',
        details: { eventKey: 'minutes.minute.generated_v1' },
      });

      logRuntimeMonitor('warn', 'feishu_event_subscription', 'event_subscription_check_authorization_required', {
        ...traceContext,
        stage: 'event_subscription_check',
        integrationId,
        profileName: integration.profileName,
        userId: user.id,
        durationMs: getElapsedMs(startedAt),
      });

      return NextResponse.json({
        success: true,
        data: {
          eventFound: false,
          status: 'pending',
          error: '请先完成飞书用户授权',
        },
      });
    }

    const listener = await startListener(integrationId);

    await upsertFeishuIntegrationCheckStatus({
      integrationId,
      eventSubscriptionStatus: 'success',
      lastErrorType: null,
      lastErrorMessage: null,
      details: {
        eventKey: 'minutes.minute.generated_v1',
        listenerStatus: listener.state,
        profileName: integration.profileName,
        readyAt: listener.readyAt?.toISOString() || null,
      },
    });

    logRuntimeMonitor('info', 'feishu_event_subscription', 'event_subscription_check_completed', {
      ...traceContext,
      stage: 'event_subscription_check',
      integrationId,
      profileName: integration.profileName,
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
      userId: user.id,
      durationMs: getElapsedMs(startedAt),
      ...toRuntimeErrorContext(error),
    });

    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '事件监听校验失败' },
      { status: 500 }
    );
  }
}
