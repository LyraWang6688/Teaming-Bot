import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getUserFeishuIntegrationContext, upsertFeishuAuthorization } from '@/lib/feishu/integration/integrationStore';
import { getDeviceCode, deleteDeviceCode } from '@/lib/feishu/authDeviceCodeStore';
import { findUserByFeishuOpenId, updateUserIdentityFromFeishu } from '@/lib/auth/userStore';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getRequestTraceContext } from '@/lib/platform/requestTrace';
import { execFile } from 'child_process';

const POLL_TIMEOUT = 12000;

function getElapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

type CliAuthError = {
  type?: string;
  subtype?: string;
  message?: string;
  param?: string;
};

type AuthPollResult =
  | {
      status: 'completed';
      stdout: string;
    }
  | {
      status: 'pending' | 'expired' | 'denied' | 'error';
      error: string;
      errorType?: string;
      errorSubtype?: string;
      raw?: string;
    };

function extractJsonPayload(output: string): unknown | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function getCliAuthError(stdout: string, stderr: string): CliAuthError | null {
  const parsed = extractJsonPayload(stdout) || extractJsonPayload(stderr);
  const envelope = parsed as { ok?: boolean; error?: CliAuthError } | null;
  if (envelope?.ok === false && envelope.error) {
    return envelope.error;
  }

  return null;
}

function classifyCliAuthError(error: CliAuthError, fallback: string): AuthPollResult {
  const message = error.message || fallback || '授权状态未知';
  const normalized = message.toLowerCase();

  if (
    normalized.includes('device_code is invalid') ||
    normalized.includes('invalid device_code') ||
    normalized.includes('expired') ||
    normalized.includes('expire')
  ) {
    return {
      status: 'expired',
      error: '授权会话无效或已过期，请重新发起授权',
      errorType: error.type,
      errorSubtype: error.subtype,
      raw: message,
    };
  }

  if (
    normalized.includes('denied') ||
    normalized.includes('declined') ||
    normalized.includes('access_denied') ||
    normalized.includes('rejected')
  ) {
    return {
      status: 'denied',
      error: '用户拒绝授权',
      errorType: error.type,
      errorSubtype: error.subtype,
      raw: message,
    };
  }

  return {
    status: 'error',
    error: message,
    errorType: error.type,
    errorSubtype: error.subtype,
    raw: fallback,
  };
}

function parseAuthResult(stdout: string): {
  openId: string;
  userName: string;
  scope: string;
} {
  const parsed = extractJsonPayload(stdout);
  if (!parsed) {
    throw new Error('lark-cli 授权结果不是有效 JSON。');
  }
  const envelope = parsed as { data?: unknown };
  const payload = envelope.data && typeof envelope.data === 'object'
    ? envelope.data as Record<string, unknown>
    : parsed as Record<string, unknown>;
  const granted = Array.isArray(payload.granted) ? payload.granted.join(' ') : '';

  return {
    openId: typeof payload.user_open_id === 'string' ? payload.user_open_id : '',
    userName: typeof payload.user_name === 'string' ? payload.user_name : '',
    scope: typeof payload.scope === 'string' ? payload.scope : granted,
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

    logRuntimeMonitor('info', 'feishu_cli_auth', 'authorize_poll_started', {
      ...traceContext,
      stage: 'authorize_poll',
      integrationId,
      profileName: integration.profileName,
      userId: user.id,
    });

    // Use lark-cli auth login --device-code to poll for completion
    // CLI uses its own stored credentials (real appSecret from keychain)
    try {
      const result = await new Promise<AuthPollResult>((resolve) => {
        execFile(
          'lark-cli',
          [
            '--profile',
            integration.profileName!,
            'auth',
            'login',
            '--device-code',
            deviceCodeEntry.deviceCode,
            '--json',
          ],
          {
            timeout: POLL_TIMEOUT,
            env: {
              ...process.env,
              LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR || '/app/.lark-cli',
            },
          },
          (error, stdout, stderr) => {
            if (stdout && stdout.includes('authorization_complete')) {
              resolve({ status: 'completed', stdout });
              return;
            }

            const cliAuthError = getCliAuthError(stdout, stderr);
            if (cliAuthError) {
              resolve(classifyCliAuthError(cliAuthError, stderr || stdout));
              return;
            }

            if (error) {
              if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || error.killed) {
                resolve({
                  status: 'pending',
                  error: '等待用户完成授权',
                  raw: stderr || stdout || error.message,
                });
                return;
              }

              resolve({
                status: 'error',
                error: stderr.trim() || stdout.trim() || error.message,
                raw: stderr || stdout,
              });
              return;
            }

            resolve({
              status: 'pending',
              error: '等待用户完成授权',
              raw: stderr || stdout,
            });
          }
        );
      });

      if (result.status !== 'completed') {
        const logLevel = result.status === 'pending' ? 'info' : result.status === 'error' ? 'error' : 'warn';
        logRuntimeMonitor(logLevel, 'feishu_cli_auth', `authorize_poll_${result.status}`, {
          ...traceContext,
          stage: 'authorize_poll',
          integrationId,
          profileName: integration.profileName,
          userId: user.id,
          durationMs: getElapsedMs(startedAt),
          errorType: result.errorType,
          errorSubtype: result.errorSubtype,
          errorMessage: result.error,
          raw: result.raw?.slice(0, 2000),
        });

        if (result.status === 'expired' || result.status === 'denied') {
          deleteDeviceCode(integrationId);
        }

        return NextResponse.json({
          success: true,
          data: { status: result.status, error: result.status === 'pending' ? undefined : result.error },
        });
      }

      // Authorization complete! Parse the result
      const { openId, userName, scope } = parseAuthResult(result.stdout);

      if (!openId) {
        throw new Error('授权完成但 lark-cli 未返回 user_open_id。');
      }

      // Store the authorization in our database
      if (openId) {
        const existingBoundUser = await findUserByFeishuOpenId(openId);
        if (existingBoundUser && existingBoundUser.id !== user.id) {
          logRuntimeMonitor('warn', 'feishu_cli_auth', 'authorize_poll_user_conflict', {
            ...traceContext,
            stage: 'authorize_poll',
            integrationId,
            profileName: integration.profileName,
            userId: user.id,
            existingUserId: existingBoundUser.id,
            authorizedOpenId: openId,
          });
          throw new Error('该飞书账号已绑定到其他本地用户，请退出当前会话后重新登录。');
        }

        await updateUserIdentityFromFeishu(user.id, {
          openId,
          name: userName || user.name || openId,
        });
      }

      await upsertFeishuAuthorization({
        integrationId,
        status: 'authorized',
        authorizedOpenId: openId,
        authorizedUserName: userName,
        accessToken: 'cli-managed',
        refreshToken: null,
        accessTokenExpiresAt: new Date(Date.now() + 86400 * 1000),
        refreshTokenExpiresAt: null,
        scope,
      });

      deleteDeviceCode(integrationId);

      logRuntimeMonitor('info', 'feishu_cli_auth', 'authorize_poll_completed', {
        ...traceContext,
        stage: 'authorize_poll',
        integrationId,
        profileName: integration.profileName,
        userId: user.id,
        authorizedOpenId: openId,
        authorizedUserName: userName,
        scope,
        durationMs: getElapsedMs(startedAt),
      });

      return NextResponse.json({
        success: true,
        data: {
          status: 'completed',
          authorizedOpenId: openId,
          authorizedUserName: userName,
          scope,
        },
      });
    } catch (pollError) {
      throw pollError;
    }
  } catch (error) {
    logRuntimeMonitor('error', 'feishu_cli_auth', 'authorize_poll_failed', {
      ...traceContext,
      stage: 'authorize_poll',
      durationMs: getElapsedMs(startedAt),
      userId: user.id,
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '轮询失败' },
      { status: 500 }
    );
  }
}
