import { execFile, spawn } from 'child_process';
import type { FeishuIntegrationContext } from './integrationStore';
import { logRuntimeMonitor } from '@/lib/platform/runtimeMonitor';

const CLI_PROFILE_TIMEOUT_MS = 15_000;
const configuredProfiles = new Set<string>();

export class FeishuCliProfileRestoreError extends Error {
  constructor(
    message: string,
    public readonly code: 'missing_profile' | 'missing_secret' | 'restore_failed'
  ) {
    super(message);
    this.name = 'FeishuCliProfileRestoreError';
  }
}

function getCliEnv() {
  return {
    ...process.env,
    LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR || '/app/.lark-cli',
  };
}

function getProfileKey(profileName: string) {
  return `${process.env.LARKSUITE_CLI_CONFIG_DIR || '/app/.lark-cli'}:${profileName}`;
}

function isNotConfigured(stderr: string, stdout: string) {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  return text.includes('not configured') || text.includes('not_configured');
}

async function showProfile(profileName: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(
      'lark-cli',
      ['--profile', profileName, 'config', 'show'],
      {
        timeout: CLI_PROFILE_TIMEOUT_MS,
        env: getCliEnv(),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(true);
          return;
        }

        if (isNotConfigured(stderr, stdout)) {
          resolve(false);
          return;
        }

        reject(new Error(stderr.trim() || stdout.trim() || error.message));
      }
    );
  });
}

async function restoreProfile(integration: FeishuIntegrationContext): Promise<void> {
  if (!integration.profileName) {
    throw new FeishuCliProfileRestoreError('当前集成缺少 CLI profile。', 'missing_profile');
  }

  const appSecret = integration.secrets.appSecret;
  if (!appSecret || appSecret === 'PLACEHOLDER') {
    throw new FeishuCliProfileRestoreError(
      '当前集成缺少可恢复的飞书 appSecret，请重新创建飞书集成。',
      'missing_secret'
    );
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'lark-cli',
      [
        'config',
        'init',
        '--name',
        integration.profileName!,
        '--app-id',
        integration.appId,
        '--app-secret-stdin',
        '--brand',
        'feishu',
        '--lang',
        'zh',
      ],
      {
        env: getCliEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new FeishuCliProfileRestoreError('恢复飞书 CLI profile 超时。', 'restore_failed'));
    }, CLI_PROFILE_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8');
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new FeishuCliProfileRestoreError(error.message, 'restore_failed'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new FeishuCliProfileRestoreError(
          stderr.trim() || stdout.trim() || `lark-cli config init 退出码：${code}`,
          'restore_failed'
        )
      );
    });

    child.stdin?.end(`${appSecret}\n`);
  });
}

export async function ensureFeishuCliProfile(integration: FeishuIntegrationContext): Promise<void> {
  if (!integration.profileName) {
    throw new FeishuCliProfileRestoreError('当前集成缺少 CLI profile。', 'missing_profile');
  }

  const profileKey = getProfileKey(integration.profileName);
  if (configuredProfiles.has(profileKey)) {
    return;
  }

  const profileExists = await showProfile(integration.profileName);
  if (profileExists) {
    configuredProfiles.add(profileKey);
    return;
  }

  logRuntimeMonitor('warn', 'feishu_cli_profile', 'cli_profile_missing_restore_started', {
    integrationId: integration.id,
    profileName: integration.profileName,
    appId: integration.appId,
  });

  await restoreProfile(integration);
  configuredProfiles.add(profileKey);

  logRuntimeMonitor('info', 'feishu_cli_profile', 'cli_profile_restore_completed', {
    integrationId: integration.id,
    profileName: integration.profileName,
    appId: integration.appId,
  });
}
