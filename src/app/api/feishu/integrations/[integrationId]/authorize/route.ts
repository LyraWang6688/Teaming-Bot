import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getUserFeishuIntegrationContext } from '@/lib/feishu/integration/integrationStore';
import { exec } from 'child_process';

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ success: false, error: '请先登录' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { integrationId } = body;

    if (!integrationId) {
      return NextResponse.json({ success: false, error: '缺少 integrationId' }, { status: 400 });
    }

    const integration = await getUserFeishuIntegrationContext(user.id, integrationId);
    if (!integration) {
      return NextResponse.json({ success: false, error: '未找到集成配置' }, { status: 404 });
    }

    if (!integration.profileName) {
      return NextResponse.json({ success: false, error: '集成配置缺少 profileName' }, { status: 400 });
    }

    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/auth/callback`;
    
    const authResult = await new Promise<string>((resolve, reject) => {
      exec(
        `lark-cli auth login --app-id ${integration.appId} --profile ${integration.profileName} --scope "minutes:minutes.basic:read minutes:minutes.transcript:export offline_access bitable:app" --redirect-uri ${redirectUri}`,
        { timeout: 60000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(stdout);
        }
      );
    });

    return NextResponse.json({
      success: true,
      data: { message: '授权卡片已发送，请在飞书客户端确认授权', result: authResult },
    });
  } catch (error) {
    console.error('[feishu:authorize] 推送授权失败', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '推送授权失败' },
      { status: 500 }
    );
  }
}
