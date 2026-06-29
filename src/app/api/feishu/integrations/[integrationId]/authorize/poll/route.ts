import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getUserFeishuIntegrationContext, upsertFeishuAuthorization } from '@/lib/feishu/integration/integrationStore';
import { getDeviceCode, deleteDeviceCode } from '@/lib/feishu/authDeviceCodeStore';
import { exec } from 'child_process';

const POLL_TIMEOUT = 12000;

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

    const deviceCodeEntry = getDeviceCode(integrationId);
    if (!deviceCodeEntry) {
      return NextResponse.json({
        success: true,
        data: { status: 'expired', error: '授权会话已过期，请重新发起授权' },
      });
    }

    const integration = await getUserFeishuIntegrationContext(user.id, integrationId);
    if (!integration || !integration.profileName) {
      return NextResponse.json({ success: false, error: '未找到集成配置' }, { status: 404 });
    }

    // Use lark-cli auth login --device-code to poll for completion
    // CLI uses its own stored credentials (real appSecret from keychain)
    try {
      const result = await new Promise<string>((resolve, reject) => {
        exec(
          `lark-cli auth login --profile ${integration.profileName} --device-code ${deviceCodeEntry.deviceCode} --json`,
          { timeout: POLL_TIMEOUT },
          (error, stdout, stderr) => {
            if (stdout && stdout.includes('authorization_complete')) {
              resolve(stdout);
              return;
            }
            if (error) {
              // Timeout or process killed — user hasn't scanned yet
              reject(new Error('pending'));
              return;
            }
            reject(new Error(stderr || 'unknown'));
          }
        );
      });

      // Authorization complete! Parse the result
      const parsed = JSON.parse(result);
      const openId = parsed.user_open_id || '';
      const userName = parsed.user_name || '';
      const scope = parsed.scope || '';
      const granted = Array.isArray(parsed.granted) ? parsed.granted.join(' ') : '';

      // Get user open_id and name from the authorization (the CLI has the real token)
      // We need to make a separate call to store the user info
      const feishuUserInfo = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
        headers: { Authorization: `Bearer lark-cli-token` },
      }).catch(() => null);

      // Store the authorization in our database
      await upsertFeishuAuthorization({
        integrationId,
        status: 'authorized',
        authorizedOpenId: openId,
        authorizedUserName: userName,
        accessToken: 'stored-by-cli', // CLI manages the real token
        refreshToken: null,
        accessTokenExpiresAt: new Date(Date.now() + 86400 * 1000),
        refreshTokenExpiresAt: null,
        scope: scope || granted,
      });

      deleteDeviceCode(integrationId);

      return NextResponse.json({
        success: true,
        data: {
          status: 'completed',
          authorizedOpenId: openId,
          authorizedUserName: userName,
          scope: scope || granted,
        },
      });
    } catch (pollError) {
      const msg = pollError instanceof Error ? pollError.message : String(pollError);
      if (msg === 'pending') {
        return NextResponse.json({ success: true, data: { status: 'pending' } });
      }
      if (msg.includes('expired') || msg.includes('timeout')) {
        deleteDeviceCode(integrationId);
        return NextResponse.json({
          success: true,
          data: { status: 'expired', error: '授权超时，请重新发起' },
        });
      }
      if (msg.includes('denied')) {
        return NextResponse.json({ success: true, data: { status: 'denied', error: '用户拒绝授权' } });
      }
      return NextResponse.json({
        success: true,
        data: { status: 'error', error: msg },
      });
    }
  } catch (error) {
    console.error('[feishu:authorize:poll] 轮询失败', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '轮询失败' },
      { status: 500 }
    );
  }
}
