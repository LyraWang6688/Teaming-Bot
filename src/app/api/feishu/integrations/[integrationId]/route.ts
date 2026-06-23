import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getFeishuIntegrationCheckStatus,
  getLatestFeishuAuthorization,
  getUserFeishuIntegrationDetail,
  updateUserFeishuIntegration,
} from '@/lib/feishu/integrationStore';
import { getAuthenticatedUser } from '@/lib/supabase/server';

const updateIntegrationSchema = z.object({
  name: z.string().trim().min(1).optional(),
  appId: z.string().trim().min(1).optional(),
  appSecret: z.string().trim().min(1).optional(),
  webhookVerificationToken: z.string().trim().min(1).optional(),
  baseAppToken: z.string().trim().min(1).nullable().optional(),
  meetingTableId: z.string().trim().min(1).nullable().optional(),
  oauthScope: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
  setupStep: z.string().trim().min(1).optional(),
  initializedAt: z.string().datetime().nullable().optional(),
});

type RouteContext = {
  params: Promise<{
    integrationId: string;
  }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json(
      { success: false, error: '请先登录后再查看飞书集成配置。' },
      { status: 401 }
    );
  }

  const { integrationId } = await context.params;
  const integration = await getUserFeishuIntegrationDetail(user.id, integrationId);
  if (!integration) {
    return NextResponse.json(
      { success: false, error: '未找到对应的飞书集成配置。' },
      { status: 404 }
    );
  }

  const [authorization, checks] = await Promise.all([
    getLatestFeishuAuthorization(integrationId),
    getFeishuIntegrationCheckStatus(integrationId),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      integration,
      authorization,
      checks,
    },
  });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json(
      { success: false, error: '请先登录后再更新飞书集成配置。' },
      { status: 401 }
    );
  }

  const parsed = updateIntegrationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message || '参数不完整' },
      { status: 400 }
    );
  }

  const { integrationId } = await context.params;
  const integration = await updateUserFeishuIntegration(user.id, integrationId, {
    ...parsed.data,
    initializedAt:
      parsed.data.initializedAt === undefined
        ? undefined
        : parsed.data.initializedAt
          ? new Date(parsed.data.initializedAt)
          : null,
  });

  if (!integration) {
    return NextResponse.json(
      { success: false, error: '未找到对应的飞书集成配置。' },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    data: integration,
  });
}
