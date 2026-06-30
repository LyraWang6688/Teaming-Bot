import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { storeProcess, getProcess } from '@/lib/feishu/cliProcessStore';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { getRequestTraceContext } from '@/lib/platform/requestTrace';

function getElapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const traceContext = getRequestTraceContext(request);
  let sessionToken = '';
  let profileName = '';

  try {
    sessionToken = randomUUID().slice(0, 8);
    profileName = `teaming-${sessionToken}`;

    logRuntimeMonitor('info', 'feishu_cli_setup', 'create_app_started', {
      ...traceContext,
      stage: 'create_app',
      sessionToken,
      profileName,
    });

    const child = spawn('lark-cli', [
      'config', 'init', '--new',
      '--name', profileName,
      '--force-init',
      '--lang', 'zh',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000,
      env: {
        ...process.env,
        LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR || '/app/.lark-cli',
      },
    });

    // Store entry first — listeners will update the stored ref
    storeProcess(sessionToken, {
      child,
      profileName,
      startedAt: new Date(),
      integrationId: null,
      stdoutBuffer: '',
      stderrBuffer: '',
    });

    let verificationUrl: string | null = null;

    child.stdout?.on('data', (data: Buffer) => {
      const entry = getProcess(sessionToken);
      if (entry) {
        entry.stdoutBuffer += data.toString();
      }
      logRuntimeMonitor('info', 'feishu_cli_setup', 'create_app_stdout_received', {
        ...traceContext,
        stage: 'create_app',
        sessionToken,
        profileName,
        bytes: data.length,
      });
    });

    child.stderr?.on('data', (data: Buffer) => {
      const stderrText = data.toString();
      const entry = getProcess(sessionToken);
      if (entry) {
        entry.stderrBuffer += stderrText;
      }
      logRuntimeMonitor('info', 'feishu_cli_setup', 'create_app_stderr_received', {
        ...traceContext,
        stage: 'create_app',
        sessionToken,
        profileName,
        bytes: data.length,
        hasVerificationUrl: /https:\/\/[^\s]+/.test(stderrText),
      });
      if (!verificationUrl) {
        const text = entry ? entry.stderrBuffer : stderrText;
        const match = text.match(/https:\/\/[^\s]+/);
        if (match) {
          verificationUrl = match[0];
        }
      }
    });

    child.on('error', (err) => {
      logRuntimeMonitor('error', 'feishu_cli_setup', 'create_app_process_error', {
        ...traceContext,
        stage: 'create_app',
        sessionToken,
        profileName,
        durationMs: getElapsedMs(startedAt),
        ...toRuntimeErrorContext(err),
      });
    });

    // Wait up to 5 seconds for the URL to appear
    const url = await new Promise<string | null>((resolve) => {
      const check = setInterval(() => {
        if (verificationUrl) {
          clearInterval(check);
          resolve(verificationUrl);
        }
      }, 200);
      setTimeout(() => {
        clearInterval(check);
        resolve(verificationUrl);
      }, 5000);
    });

    if (!url) {
      child.kill();
      logRuntimeMonitor('error', 'feishu_cli_setup', 'create_app_verification_url_missing', {
        ...traceContext,
        stage: 'create_app',
        sessionToken,
        profileName,
        durationMs: getElapsedMs(startedAt),
      });
      return NextResponse.json(
        { success: false, error: '无法获取二维码，请重试' },
        { status: 500 }
      );
    }

    logRuntimeMonitor('info', 'feishu_cli_setup', 'create_app_verification_url_ready', {
      ...traceContext,
      stage: 'create_app',
      sessionToken,
      profileName,
      durationMs: getElapsedMs(startedAt),
    });

    return NextResponse.json({
      success: true,
      data: {
        verificationUrl: url,
        sessionToken,
        profileName,
      },
    });
  } catch (error) {
    logRuntimeMonitor('error', 'feishu_cli_setup', 'create_app_failed', {
      ...traceContext,
      stage: 'create_app',
      sessionToken,
      profileName,
      durationMs: getElapsedMs(startedAt),
      ...toRuntimeErrorContext(error),
    });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '创建应用失败' },
      { status: 500 }
    );
  }
}
