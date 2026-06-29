import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { createUserFeishuIntegration, type FeishuIntegrationView } from '@/lib/feishu/integration/integrationStore';
import { exec } from 'child_process';

const REQUIRED_USER_PERMISSIONS = [
  'bitable:app',
  'minutes:minutes.basic:read',
  'minutes:minutes.transcript:export',
  'offline_access',
];

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ success: false, error: '请先登录' }, { status: 401 });
  }

  try {
    const appName = `Teaming-Bot-${user.id.slice(0, 8)}`;
    const profileName = `teaming-${user.id.slice(0, 8)}`;
    
    const createResult = await new Promise<string>((resolve, reject) => {
      exec(
        `lark-cli app create "${appName}" --app-name "${appName}" --description "智能会议分析工具"`,
        { timeout: 30000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(stdout);
        }
      );
    });

    const appIdMatch = createResult.match(/app_id["']?\s*[:=]\s*["']?([^"'\\s]+)["']?/);
    const appSecretMatch = createResult.match(/app_secret["']?\s*[:=]\s*["']?([^"'\\s]+)["']?/);

    if (!appIdMatch || !appSecretMatch) {
      throw new Error('创建应用失败，无法解析 App ID 和 App Secret');
    }

    const appId = appIdMatch[1];
    const appSecret = appSecretMatch[1];

    for (const permission of REQUIRED_USER_PERMISSIONS) {
      await new Promise<string>((resolve, reject) => {
        exec(
          `lark-cli app add-permission --app-id ${appId} --permission ${permission}`,
          { timeout: 30000 },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(`添加权限 ${permission} 失败: ${stderr || error.message}`));
              return;
            }
            resolve(stdout);
          }
        );
      });
    }

    await new Promise<string>((resolve, reject) => {
      exec(
        `lark-cli app add-event-subscription --app-id ${appId} --event minutes.minute.generated_v1`,
        { timeout: 30000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(stdout);
        }
      );
    });

    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/auth/callback`;
    
    await new Promise<string>((resolve, reject) => {
      exec(
        `lark-cli app set-oauth-redirect-uri --app-id ${appId} --redirect-uri ${redirectUri}`,
        { timeout: 30000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(stdout);
        }
      );
    });

    const integration = await createUserFeishuIntegration({
      userId: user.id,
      name: appName,
      appId,
      appSecret,
      profileName,
      oauthScope: 'minutes:minutes.basic:read minutes:minutes.transcript:export offline_access bitable:app',
    });

    return NextResponse.json({
      success: true,
      data: integration,
    });
  } catch (error) {
    console.error('[feishu:create-app] 创建应用失败', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '创建应用失败' },
      { status: 500 }
    );
  }
}
