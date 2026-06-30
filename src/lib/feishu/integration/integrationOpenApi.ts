import {
  getLatestFeishuAuthorizationContext,
  type FeishuAuthorizationContext,
  type FeishuIntegrationContext,
} from './integrationStore';
import { ensureFeishuCliProfile } from './cliProfileManager';
import { FeishuOpenApiError } from '../common/openapi';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import { execFile } from 'child_process';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

const CLI_OPENAPI_TIMEOUT_MS = 60_000;
const CLI_OPENAPI_MAX_BUFFER = 10 * 1024 * 1024;

export async function getValidIntegrationUserAuthorization(
  integration: FeishuIntegrationContext
): Promise<FeishuAuthorizationContext> {
  const authorization = await getLatestFeishuAuthorizationContext(integration.id);
  if (!authorization) {
    throw new Error('当前集成尚未完成 OAuth 授权。');
  }

  if (authorization.status !== 'authorized') {
    throw new Error('当前集成 OAuth 授权状态不可用。');
  }

  return authorization;
}

function splitPathAndParams(path: string): {
  normalizedPath: string;
  params: Record<string, string | string[]>;
} {
  const [rawPath, query = ''] = path.split('?');
  const params: Record<string, string | string[]> = {};
  const searchParams = new URLSearchParams(query);

  for (const [key, value] of searchParams.entries()) {
    const existing = params[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else if (typeof existing === 'string') {
      params[key] = [existing, value];
    } else {
      params[key] = value;
    }
  }

  return {
    normalizedPath: rawPath.startsWith('/open-apis/')
      ? rawPath
      : `/open-apis/${rawPath.replace(/^\/+/, '')}`,
    params,
  };
}

function buildCliArgs(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>,
  options?: {
    outputPath?: string;
    cwd?: string;
  }
): string[] {
  if (!integration.profileName) {
    throw new Error('当前集成缺少 CLI profile，无法通过 lark-cli 调用飞书 API。');
  }

  const { normalizedPath, params } = splitPathAndParams(path);
  const args = [
    '--profile',
    integration.profileName,
    'api',
    method,
    normalizedPath,
    '--as',
    'user',
    '--format',
    'json',
  ];

  if (Object.keys(params).length > 0) {
    args.push('--params', JSON.stringify(params));
  }

  if (method !== 'GET' && method !== 'DELETE' && data) {
    args.push('--data', JSON.stringify(data));
  }

  if (options?.outputPath) {
    args.push('--output', options.outputPath);
  }

  return args;
}

function parseCliJson<T>(stdout: string, method: HttpMethod, path: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined as T;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new FeishuOpenApiError({
      message: `lark-cli 返回了非 JSON 响应：${method} ${path}`,
      method,
      path,
      body: trimmed.slice(0, 1000),
    });
  }

  const envelope = parsed as {
    ok?: boolean;
    code?: number;
    msg?: string;
    data?: unknown;
    error?: { message?: string; code?: number };
  };

  if (envelope.ok === false || (typeof envelope.code === 'number' && envelope.code !== 0)) {
    throw new FeishuOpenApiError({
      message: envelope.error?.message || envelope.msg || `lark-cli API 调用失败：${method} ${path}`,
      method,
      path,
      code: envelope.error?.code || envelope.code,
      body: trimmed.slice(0, 2000),
    });
  }

  if (Object.prototype.hasOwnProperty.call(envelope, 'data')) {
    return envelope.data as T;
  }

  return parsed as T;
}

async function callLarkCliOpenApi(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>,
  options?: {
    outputPath?: string;
    cwd?: string;
  }
): Promise<string> {
  const startedAt = Date.now();
  await getValidIntegrationUserAuthorization(integration);
  await ensureFeishuCliProfile(integration);
  const args = buildCliArgs(integration, method, path, data, options);

  logRuntimeMonitor('info', 'integration_openapi', 'integration_user_cli_request_started', {
    integrationId: integration.id,
    profileName: integration.profileName,
    method,
    path,
    stage: 'cli_openapi_request',
  });

  return new Promise((resolve, reject) => {
    execFile(
      'lark-cli',
      args,
      {
        timeout: CLI_OPENAPI_TIMEOUT_MS,
        maxBuffer: CLI_OPENAPI_MAX_BUFFER,
        cwd: options?.cwd,
        env: {
          ...process.env,
          LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR || '/app/.lark-cli',
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          logRuntimeMonitor('info', 'integration_openapi', 'integration_user_cli_request_completed', {
            integrationId: integration.id,
            profileName: integration.profileName,
            method,
            path,
            stage: 'cli_openapi_request',
            durationMs: Date.now() - startedAt,
            stdoutBytes: Buffer.byteLength(stdout),
            outputPath: options?.outputPath,
            cwd: options?.cwd,
          });
          resolve(stdout);
          return;
        }

        const message = stderr.trim() || error.message;
        logRuntimeMonitor('error', 'integration_openapi', 'integration_user_cli_request_failed', {
          integrationId: integration.id,
          method,
          path,
          profileName: integration.profileName,
          stage: 'cli_openapi_request',
          durationMs: Date.now() - startedAt,
          message,
          outputPath: options?.outputPath,
          cwd: options?.cwd,
        });

        reject(
          new FeishuOpenApiError({
            message,
            method,
            path,
            statusCode: typeof error.code === 'number' ? error.code : undefined,
            body: stderr.slice(0, 2000),
          })
        );
      }
    );
  });
}

export async function callFeishuIntegrationUserOpenApi<T = unknown>(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>
): Promise<T> {
  const stdout = await callLarkCliOpenApi(integration, method, path, data);
  return parseCliJson<T>(stdout, method, path);
}

export async function callFeishuIntegrationUserOpenApiText(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>
): Promise<string> {
  const stdout = await callLarkCliOpenApi(integration, method, path, data);
  const trimmed = stdout.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const envelope = parsed as {
      ok?: boolean;
      code?: number;
      msg?: string;
      data?: unknown;
      error?: { message?: string; code?: number };
    };

    if (envelope.ok === false || (typeof envelope.code === 'number' && envelope.code !== 0)) {
      throw new FeishuOpenApiError({
        message: envelope.error?.message || envelope.msg || `lark-cli API 调用失败：${method} ${path}`,
        method,
        path,
        code: envelope.error?.code || envelope.code,
        body: trimmed.slice(0, 2000),
      });
    }

    const payload = Object.prototype.hasOwnProperty.call(envelope, 'data')
      ? envelope.data
      : parsed;

    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object') {
      const maybeContent = (payload as { content?: unknown }).content;
      if (typeof maybeContent === 'string') return maybeContent;
    }
    return JSON.stringify(payload);
  } catch (error) {
    if (error instanceof FeishuOpenApiError) {
      throw error;
    }
    logRuntimeMonitor('warn', 'integration_openapi', 'integration_user_cli_text_parse_fallback', {
      integrationId: integration.id,
      method,
      path,
      ...toRuntimeErrorContext(error),
    });
    return trimmed;
  }
}

export async function downloadFeishuIntegrationUserOpenApiFile(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  outputPath: string,
  cwd: string,
  data?: Record<string, unknown>
): Promise<void> {
  if (!outputPath) {
    throw new Error('下载飞书 OpenAPI 文件时缺少 outputPath。');
  }

  if (!cwd) {
    throw new Error('下载飞书 OpenAPI 文件时缺少 cwd。');
  }

  await callLarkCliOpenApi(integration, method, path, data, { outputPath, cwd });
}

export {
  callFeishuIntegrationUserOpenApi as callFeishuIntegrationUserCliOpenApi,
  callFeishuIntegrationUserOpenApiText as callFeishuIntegrationUserCliOpenApiText,
  downloadFeishuIntegrationUserOpenApiFile as downloadFeishuIntegrationUserCliOpenApiFile,
};
