import * as lark from '@larksuiteoapi/node-sdk';
import { isAbsolute, join } from 'path';
import { writeFile } from 'fs/promises';
import type { FeishuIntegrationContext } from './integrationStore';
import { createFeishuSdkClient } from './sdkClient';
import { getValidIntegrationUserAuthorization } from './tokenService';
import { FeishuOpenApiError } from '../common/openapi';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

type FeishuEnvelope<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

type HttpErrorLike = Error & {
  response?: {
    status?: number;
    data?: unknown;
  };
};

function splitPathAndParams(path: string): {
  normalizedPath: string;
  params: Record<string, string | string[]>;
} {
  const url = new URL(path, 'https://open.feishu.cn');
  const params: Record<string, string | string[]> = {};

  for (const [key, value] of url.searchParams.entries()) {
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
    normalizedPath: url.pathname.startsWith('/open-apis/')
      ? url.pathname
      : `/open-apis/${url.pathname.replace(/^\/+/, '')}`,
    params,
  };
}

function unwrapFeishuResponse<T>(
  response: FeishuEnvelope<T> | T,
  method: HttpMethod,
  path: string
): T {
  if (!response || typeof response !== 'object') {
    return response as T;
  }

  const envelope = response as FeishuEnvelope<T>;
  if (typeof envelope.code === 'number' && envelope.code !== 0) {
    throw new FeishuOpenApiError({
      message: envelope.msg || `飞书 OpenAPI 调用失败：${method} ${path}`,
      method,
      path,
      code: envelope.code,
    });
  }

  if (Object.prototype.hasOwnProperty.call(envelope, 'data')) {
    return envelope.data as T;
  }

  return response as T;
}

function mapSdkError(error: unknown, method: HttpMethod, path: string): FeishuOpenApiError {
  if (error instanceof FeishuOpenApiError) {
    return error;
  }

  const httpError = error as HttpErrorLike;
  const responseData = httpError.response?.data as
    | { code?: number; msg?: string; error?: string; error_description?: string }
    | undefined;

  return new FeishuOpenApiError({
    message:
      responseData?.msg ||
      responseData?.error_description ||
      responseData?.error ||
      (error instanceof Error ? error.message : `飞书 OpenAPI 调用失败：${method} ${path}`),
    method,
    path,
    statusCode: httpError.response?.status,
    code: responseData?.code,
  });
}

async function requestFeishuIntegrationUserOpenApi<T>(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>,
  responseType: 'json' | 'text' | 'arraybuffer' = 'json'
): Promise<T> {
  const startedAt = Date.now();
  const authorization = await getValidIntegrationUserAuthorization(integration);
  const client = createFeishuSdkClient(integration);
  const { normalizedPath, params } = splitPathAndParams(path);

  logRuntimeMonitor('info', 'integration_openapi', 'integration_user_sdk_request_started', {
    integrationId: integration.id,
    method,
    path: normalizedPath,
    stage: 'sdk_openapi_request',
  });

  try {
    const response = await client.request<FeishuEnvelope<T> | T>(
      {
        method,
        url: normalizedPath,
        params,
        data: method === 'GET' || method === 'DELETE' ? undefined : data,
        responseType,
        timeout: 60_000,
      },
      lark.withUserAccessToken(authorization.accessToken)
    );

    logRuntimeMonitor('info', 'integration_openapi', 'integration_user_sdk_request_completed', {
      integrationId: integration.id,
      method,
      path: normalizedPath,
      stage: 'sdk_openapi_request',
      durationMs: Date.now() - startedAt,
    });

    if (responseType !== 'json') {
      return response as T;
    }
    return unwrapFeishuResponse(response, method, normalizedPath);
  } catch (error) {
    const mapped = mapSdkError(error, method, normalizedPath);
    logRuntimeMonitor('error', 'integration_openapi', 'integration_user_sdk_request_failed', {
      integrationId: integration.id,
      method,
      path: normalizedPath,
      stage: 'sdk_openapi_request',
      durationMs: Date.now() - startedAt,
      errorCode: mapped.code,
      statusCode: mapped.statusCode,
      ...toRuntimeErrorContext(mapped),
    });
    throw mapped;
  }
}

export async function callFeishuIntegrationUserOpenApi<T = unknown>(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>
): Promise<T> {
  return requestFeishuIntegrationUserOpenApi<T>(integration, method, path, data);
}

export async function callFeishuIntegrationUserOpenApiText(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  data?: Record<string, unknown>
): Promise<string> {
  const response = await requestFeishuIntegrationUserOpenApi<unknown>(
    integration,
    method,
    path,
    data,
    'text'
  );
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && 'content' in response) {
    const content = (response as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return JSON.stringify(response ?? '');
}

export async function downloadFeishuIntegrationUserOpenApiFile(
  integration: FeishuIntegrationContext,
  method: HttpMethod,
  path: string,
  outputPath: string,
  cwd: string,
  data?: Record<string, unknown>
): Promise<void> {
  if (!outputPath || !cwd) {
    throw new Error('下载飞书 OpenAPI 文件时缺少输出路径。');
  }

  const response = await requestFeishuIntegrationUserOpenApi<ArrayBuffer | Buffer>(
    integration,
    method,
    path,
    data,
    'arraybuffer'
  );
  const targetPath = isAbsolute(outputPath) ? outputPath : join(cwd, outputPath);
  const content = Buffer.isBuffer(response)
    ? response
    : Buffer.from(new Uint8Array(response));
  await writeFile(targetPath, content);
}
