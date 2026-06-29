import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getUserFeishuIntegrationContext } from '@/lib/feishu/integration/integrationStore';
import { setDeviceCode } from '@/lib/feishu/authDeviceCodeStore';
import { exec } from 'child_process';

const CLI_TIMEOUT = 15000;

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

    // Run lark-cli auth login with --no-wait to get device code + verification URL
    // CLI already has the real appSecret in its keychain from config init --new
    const authResult = await new Promise<string>((resolve, reject) => {
      exec(
        `lark-cli auth login --profile ${integration.profileName} --scope "minutes:minutes.basic:read minutes:minutes.transcript:export offline_access bitable:app" --no-wait --json`,
        { timeout: CLI_TIMEOUT },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(stdout);
        }
      );
    });

    const parsed = JSON.parse(authResult);
    const deviceCode = parsed.device_code;
    const verificationUrl = parsed.verification_url;

    if (!deviceCode || !verificationUrl) {
      return NextResponse.json(
        { success: false, error: '获取设备授权信息失败' },
        { status: 500 }
      );
    }

    // Save device code in memory for polling
    setDeviceCode(integrationId, {
      deviceCode,
      expiresAt: Date.now() + (parsed.expires_in || 300) * 1000,
      appId: integration.appId,
      appSecret: '', // Not needed — poll endpoint uses CLI directly
    });

    return NextResponse.json({
      success: true,
      data: {
        verificationUrl,
        deviceCode,
      },
    });
  } catch (error) {
    console.error('[feishu:authorize:start] 发起授权失败', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '发起授权失败' },
      { status: 500 }
    );
  }
}
