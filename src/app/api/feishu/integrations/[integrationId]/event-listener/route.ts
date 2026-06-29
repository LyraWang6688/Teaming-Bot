import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getFeishuIntegrationContextById } from '@/lib/feishu/integration/integrationStore';
import { startListener, getListenerStatus } from '@/lib/feishu/events/eventListenerManager';

type RouteContext = { params: Promise<{ integrationId: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ success: false, error: '请先登录' }, { status: 401 });
  }

  const { integrationId } = await context.params;
  const integration = await getFeishuIntegrationContextById(integrationId);
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
    },
  });
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ success: false, error: '请先登录' }, { status: 401 });
  }

  const { integrationId } = await context.params;
  const integration = await getFeishuIntegrationContextById(integrationId);
  if (!integration) {
    return NextResponse.json({ success: false, error: '未找到集成' }, { status: 404 });
  }

  try {
    startListener(integrationId);
    return NextResponse.json({
      success: true,
      data: { status: 'starting' },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '启动监听失败' },
      { status: 500 }
    );
  }
}
