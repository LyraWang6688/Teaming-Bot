import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import {
  getLatestFeishuAuthorization,
  getUserFeishuIntegrationContext,
} from '@/lib/feishu/integration/integrationStore';

type RouteContext = { params: Promise<{ integrationId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ success: false, error: '请先登录' }, { status: 401 });
  }

  const { integrationId } = await context.params;
  const integration = await getUserFeishuIntegrationContext(user.id, integrationId);
  if (!integration) {
    return NextResponse.json({ success: false, error: '未找到集成配置' }, { status: 404 });
  }

  const authorization = await getLatestFeishuAuthorization(integrationId);
  if (authorization?.status === 'authorized') {
    return NextResponse.json({
      success: true,
      data: {
        status: 'completed',
        authorizedOpenId: authorization.authorizedOpenId,
        authorizedUserName: authorization.authorizedUserName,
        scope: authorization.scope,
      },
    });
  }

  return NextResponse.json({
    success: true,
    data: {
      status: authorization?.status === 'reauthorization_required' ? 'error' : 'pending',
      error:
        authorization?.status === 'reauthorization_required'
          ? '授权已失效，请重新发起授权。'
          : undefined,
    },
  });
}
