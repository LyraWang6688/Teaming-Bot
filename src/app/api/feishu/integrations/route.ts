import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createUserFeishuIntegration,
  listUserFeishuIntegrations,
} from '@/lib/feishu/integration/integrationStore';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getCurrentUser } from '@/lib/auth/session';

const createIntegrationSchema = z.object({
  name: z.string().trim().min(1, '请输入集成名称'),
  appId: z.string().trim().min(1, '请输入 App ID'),
  appSecret: z.string().trim().min(1, '请输入 App Secret'),
  oauthScope: z.string().trim().optional(),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    logRuntimeMonitor('warn', 'integration_api', 'integration_list_rejected_unauthenticated');
    return NextResponse.json(
      { success: false, error: '请先登录后再查看飞书集成配置。' },
      { status: 401 }
    );
  }

  try {
    const integrations = await listUserFeishuIntegrations(user.id);
    logRuntimeMonitor('info', 'integration_api', 'integration_list_succeeded', {
      userId: user.id,
      count: integrations.length,
    });
    return NextResponse.json({
      success: true,
      data: integrations,
    });
  } catch (error) {
    logRuntimeMonitor('error', 'integration_api', 'integration_list_failed', {
      userId: user.id,
      ...toRuntimeErrorContext(error),
    });
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    logRuntimeMonitor('warn', 'integration_api', 'integration_create_rejected_unauthenticated');
    return NextResponse.json(
      { success: false, error: '请先登录后再创建飞书集成配置。' },
      { status: 401 }
    );
  }

  const parsed = createIntegrationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    logRuntimeMonitor('warn', 'integration_api', 'integration_create_validation_failed', {
      issueCount: parsed.error.issues.length,
      firstIssue: parsed.error.issues[0]?.message,
      userId: user.id,
    });
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message || '参数不完整' },
      { status: 400 }
    );
  }

  try {
    const integration = await createUserFeishuIntegration({
      userId: user.id,
      ...parsed.data,
    });

    logRuntimeMonitor('info', 'integration_api', 'integration_create_succeeded', {
      userId: user.id,
      integrationId: integration.id,
      appId: integration.appId,
    });

    return NextResponse.json({
      success: true,
      data: integration,
    });
  } catch (error) {
    logRuntimeMonitor('error', 'integration_api', 'integration_create_failed', {
      userId: user.id,
      ...toRuntimeErrorContext(error),
    });
    throw error;
  }
}
