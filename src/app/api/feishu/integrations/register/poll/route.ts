import { NextResponse } from 'next/server';
import { findOrCreateUserByFeishu } from '@/lib/auth/userStore';
import { createSession } from '@/lib/auth/session';
import { createUserFeishuIntegration } from '@/lib/feishu/integration/integrationStore';

const ACCOUNTS_FEISHU = 'https://accounts.feishu.cn';
const ACCOUNTS_LARK = 'https://accounts.larksuite.com';
const APP_REGISTRATION_PATH = '/oauth/v1/app/registration';

export async function POST(request: Request) {
  try {
    const { deviceCode, brand = 'feishu' } = await request.json();

    if (!deviceCode) {
      return NextResponse.json(
        { success: false, error: '缺少 deviceCode' },
        { status: 400 }
      );
    }

    const accountsUrl = brand === 'lark' ? ACCOUNTS_LARK : ACCOUNTS_FEISHU;

    const formData = new URLSearchParams();
    formData.append('action', 'poll');
    formData.append('device_code', deviceCode);

    const response = await fetch(`${accountsUrl}${APP_REGISTRATION_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });

    const data = await response.json();

    // 用户还没扫码
    if (data.error === 'authorization_pending') {
      return NextResponse.json({ success: true, status: 'pending' });
    }

    if (data.error === 'slow_down') {
      return NextResponse.json({ success: true, status: 'pending', slowDown: true });
    }

    // 用户拒绝
    if (data.error === 'access_denied') {
      return NextResponse.json({ success: false, status: 'denied', error: '用户拒绝了授权' });
    }

    // 二维码过期
    if (data.error === 'expired_token' || data.error === 'invalid_grant') {
      return NextResponse.json({ success: false, status: 'expired', error: '二维码已过期，请重新创建' });
    }

    if (data.error) {
      return NextResponse.json({
        success: false,
        status: 'error',
        error: data.error_description || data.error,
      });
    }

    // 成功：应用已创建
    const appId = data.client_id;
    const appSecret = data.client_secret;
    const userOpenId = data.user_info?.open_id;
    const tenantBrand = data.user_info?.tenant_brand || brand;

    if (!appId || !appSecret || !userOpenId) {
      return NextResponse.json(
        { success: false, error: '创建应用成功但响应数据不完整，缺少 client_id/client_secret/user_info.open_id' },
        { status: 500 }
      );
    }

    // 用 open_id 查找或创建用户
    const { user, isNew } = await findOrCreateUserByFeishu({
      openId: userOpenId,
      name: userOpenId,
    });

    // 创建会话
    await createSession(user.id);

    // 存集成配置
    const shortId = userOpenId.slice(-8);
    const profileName = `teaming-${shortId}`;

    const integration = await createUserFeishuIntegration({
      userId: user.id,
      name: `Teaming-Bot-${shortId}`,
      appId,
      appSecret,
      profileName,
      oauthScope: 'offline_access minutes:minutes.search:read minutes:minutes.transcript:export',
    });

    console.log('[feishu:register:poll] 应用创建成功', {
      integrationId: integration.id,
      appId: integration.appId,
      brand: tenantBrand,
      userOpenId,
      isNewUser: isNew,
    });

    return NextResponse.json({
      success: true,
      status: 'completed',
      data: {
        integration,
        user: { id: user.id, feishuOpenId: userOpenId },
      },
    });
  } catch (error) {
    console.error('[feishu:register:poll] 轮询失败', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '轮询注册状态失败' },
      { status: 500 }
    );
  }
}
