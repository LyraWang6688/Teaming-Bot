import { NextResponse } from 'next/server';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { storeProcess, getProcess } from '@/lib/feishu/cliProcessStore';

export async function POST() {
  try {
    const sessionToken = randomUUID().slice(0, 8);
    const profileName = `teaming-${sessionToken}`;

    const child = spawn('lark-cli', [
      'config', 'init', '--new',
      '--name', profileName,
      '--force-init',
      '--lang', 'zh',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000,
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
    });

    child.stderr?.on('data', (data: Buffer) => {
      const entry = getProcess(sessionToken);
      if (entry) {
        entry.stderrBuffer += data.toString();
      }
      if (!verificationUrl) {
        const text = entry ? entry.stderrBuffer : data.toString();
        const match = text.match(/https:\/\/[^\s]+/);
        if (match) {
          verificationUrl = match[0];
        }
      }
    });

    child.on('error', (err) => {
      console.error('[feishu:create-app] 子进程错误', err);
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
      return NextResponse.json(
        { success: false, error: '无法获取二维码，请重试' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        verificationUrl: url,
        sessionToken,
        profileName,
      },
    });
  } catch (error) {
    console.error('[feishu:create-app] 创建应用失败', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '创建应用失败' },
      { status: 500 }
    );
  }
}
