import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createUserFeishuIntegration,
  listUserFeishuIntegrations,
} from '@/lib/feishu/integrationStore';
import { getAuthenticatedUser } from '@/lib/supabase/server';

const createIntegrationSchema = z.object({
  name: z.string().trim().min(1, '请输入集成名称'),
  appId: z.string().trim().min(1, '请输入 App ID'),
  appSecret: z.string().trim().min(1, '请输入 App Secret'),
  webhookVerificationToken: z.string().trim().min(1, '请输入 Webhook Verification Token'),
  baseAppToken: z.string().trim().min(1).nullable().optional(),
  meetingTableId: z.string().trim().min(1).nullable().optional(),
  oauthScope: z.string().trim().optional(),
});

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json(
      { success: false, error: '请先登录后再查看飞书集成配置。' },
      { status: 401 }
    );
  }

  const integrations = await listUserFeishuIntegrations(user.id);
  return NextResponse.json({
    success: true,
    data: integrations,
  });
}

export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json(
      { success: false, error: '请先登录后再创建飞书集成配置。' },
      { status: 401 }
    );
  }

  const parsed = createIntegrationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message || '参数不完整' },
      { status: 400 }
    );
  }

  const integration = await createUserFeishuIntegration({
    userId: user.id,
    ...parsed.data,
  });

  return NextResponse.json({
    success: true,
    data: integration,
  });
}
