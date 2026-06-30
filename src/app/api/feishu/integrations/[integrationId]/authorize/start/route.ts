import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getUserFeishuIntegrationContext } from '@/lib/feishu/integration/integrationStore';
import { setDeviceCode } from '@/lib/feishu/authDeviceCodeStore';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getRequestTraceContext } from '@/lib/platform/requestTrace';
import { ensureFeishuCliProfile } from '@/lib/feishu/integration/cliProfileManager';
import { execFile } from 'child_process';

const CLI_TIMEOUT = 15000;
const AUTH_SCOPE = 'minutes:minutes.basic:read minutes:minutes.transcript:export offline_access bitable:app';

function getElapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

function parseAuthStartResult(stdout: string): {
  deviceCode?: string;
  verificationUrl?: string;
  expiresIn?: number;
} {
  const parsed = JSON.parse(stdout);
  const payload = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;

  return {
    deviceCode: payload.device_code,
    verificationUrl: payload.verification_url,
    expiresIn: payload.expires_in,
  };
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const traceContext = getRequestTraceContext(request);
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
    await ensureFeishuCliProfile(integration);

    logRuntimeMonitor('info', 'feishu_cli_auth', 'authorize_start_started', {
      ...traceContext,
      stage: 'authorize_start',
      integrationId,
      profileName: integration.profileName,
      userId: user.id,
      oauthScope: AUTH_SCOPE,
    });

    // Run lark-cli auth login with --no-wait to get device code + verification URL
    // CLI already has the real appSecret in its keychain from config init --new
    const authResult = await new Promise<string>((resolve, reject) => {
      execFile(
        'lark-cli',
        [
          '--profile',
          integration.profileName!,
          'auth',
          'login',
          '--scope',
          AUTH_SCOPE,
          '--no-wait',
          '--json',
        ],
        {
          timeout: CLI_TIMEOUT,
          env: {
            ...process.env,
            LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR || '/app/.lark-cli',
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            const cliError = new Error(stderr || error.message);
            logRuntimeMonitor('error', 'feishu_cli_auth', 'authorize_start_cli_failed', {
              ...traceContext,
              stage: 'authorize_start',
              integrationId,
              profileName: integration.profileName,
              userId: user.id,
              durationMs: getElapsedMs(startedAt),
              stderr: stderr.slice(0, 2000),
              ...toRuntimeErrorContext(cliError),
            });
            reject(cliError);
            return;
          }
          resolve(stdout);
        }
      );
    });

    const parsed = parseAuthStartResult(authResult);
    const deviceCode = parsed.deviceCode;
    const verificationUrl = parsed.verificationUrl;

    if (!deviceCode || !verificationUrl) {
      logRuntimeMonitor('error', 'feishu_cli_auth', 'authorize_start_parse_failed', {
        ...traceContext,
        stage: 'authorize_start',
        integrationId,
        profileName: integration.profileName,
        userId: user.id,
        durationMs: getElapsedMs(startedAt),
        hasDeviceCode: Boolean(deviceCode),
        hasVerificationUrl: Boolean(verificationUrl),
      });
      return NextResponse.json(
        { success: false, error: '获取设备授权信息失败' },
        { status: 500 }
      );
    }

    // Save device code in memory for polling
    setDeviceCode(integrationId, {
      deviceCode,
      expiresAt: Date.now() + (parsed.expiresIn || 300) * 1000,
      appId: integration.appId,
      appSecret: '', // Not needed — poll endpoint uses CLI directly
    });

    logRuntimeMonitor('info', 'feishu_cli_auth', 'authorize_start_completed', {
      ...traceContext,
      stage: 'authorize_start',
      integrationId,
      profileName: integration.profileName,
      userId: user.id,
      durationMs: getElapsedMs(startedAt),
      expiresIn: parsed.expiresIn || 300,
    });

    return NextResponse.json({
      success: true,
      data: {
        verificationUrl,
        deviceCode,
      },
    });
  } catch (error) {
    logRuntimeMonitor('error', 'feishu_cli_auth', 'authorize_start_failed', {
      ...traceContext,
      stage: 'authorize_start',
      durationMs: getElapsedMs(startedAt),
      userId: user.id,
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '发起授权失败' },
      { status: 500 }
    );
  }
}
