import { NextResponse } from 'next/server';

const ACCOUNTS_FEISHU = 'https://accounts.feishu.cn';
const OPEN_FEISHU = 'https://open.feishu.cn';
const APP_REGISTRATION_PATH = '/oauth/v1/app/registration';

export async function POST() {
  try {
    const formData = new URLSearchParams();
    formData.append('action', 'begin');
    formData.append('archetype', 'PersonalAgent');
    formData.append('auth_method', 'client_secret');
    formData.append('request_user_info', 'open_id tenant_brand');

    const response = await fetch(`${ACCOUNTS_FEISHU}${APP_REGISTRATION_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });

    const body = await response.json();

    if (response.status >= 400 || body.error) {
      return NextResponse.json(
        { success: false, error: body.error_description || body.error || '创建应用失败' },
        { status: 500 }
      );
    }

    const verificationUrl = `${OPEN_FEISHU}/page/cli?user_code=${body.user_code}`;

    return NextResponse.json({
      success: true,
      data: {
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUrl,
        expiresIn: body.expires_in,
        interval: body.interval,
      },
    });
  } catch (error) {
    console.error('[feishu:create-app] 发起设备流失败', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '创建应用失败' },
      { status: 500 }
    );
  }
}
