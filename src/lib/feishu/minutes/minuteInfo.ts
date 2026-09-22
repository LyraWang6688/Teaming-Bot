import { callFeishuIntegrationUserOpenApi } from '../integration/integrationOpenApi';
import { logFeishuMonitor } from '../common/monitor';
import { FeishuOpenApiError } from '../common/openapi';
import { type FeishuIntegrationContext, writeAuditLog } from '../integration/integrationStore';

/**
 * 妙记信息接口返回的原始数据结构
 * 文档：https://open.feishu.cn/document/server-docs/minutes-v1/minute/get
 */
type RawMinute = {
  token?: unknown;
  owner_id?: unknown;
  create_time?: unknown;
  title?: unknown;
  duration?: unknown;
  url?: unknown;
  note_id?: unknown;
};

type MinuteInfoResponse = {
  minute?: RawMinute;
};

export type MinuteInfo = {
  token: string;
  ownerId: string | null;
  title: string | null;
  createTime: string | null;
  duration: string | null;
  url: string | null;
  noteId: string | null;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function mapMinuteInfo(token: string, minute: RawMinute): MinuteInfo {
  return {
    token: asString(minute.token) || token,
    ownerId: asString(minute.owner_id),
    title: asString(minute.title),
    createTime: asString(minute.create_time),
    duration: asString(minute.duration),
    url: asString(minute.url),
    noteId: asString(minute.note_id),
  };
}

export class MinuteInfoError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'MinuteInfoError';
  }
}

/**
 * 获取妙记完整信息
 *
 * 用于门槛判断（owner_id）和会议元数据补全（title、noteId 等）。
 */
export async function fetchMinuteInfo(
  minuteToken: string,
  integration: FeishuIntegrationContext
): Promise<MinuteInfo> {
  const startedAt = Date.now();
  logFeishuMonitor('info', 'minute_info_fetch_started', {
    userId: integration.userId,
    integrationId: integration.id,
    minuteToken,
  });

  try {
    const query = new URLSearchParams({ user_id_type: 'open_id' });
    const response = await callFeishuIntegrationUserOpenApi<MinuteInfoResponse>(
      integration,
      'GET',
      `/minutes/v1/minutes/${encodeURIComponent(minuteToken)}?${query.toString()}`,
      undefined,
      { errorLogging: 'caller' }
    );

    if (!response.minute) {
      throw new MinuteInfoError('minute_response_invalid', '妙记信息尚不可用。', true);
    }

    const info = mapMinuteInfo(minuteToken, response.minute);

    await writeAuditLog({
      userId: integration.userId,
      integrationId: integration.id,
      action: 'minute.info.read',
      result: 'success',
      summary: '读取妙记信息',
      metadata: {
        minuteToken,
        hasOwner: Boolean(info.ownerId),
        hasTitle: Boolean(info.title),
        durationMs: Date.now() - startedAt,
      },
    });

    logFeishuMonitor('info', 'minute_info_fetch_succeeded', {
      userId: integration.userId,
      integrationId: integration.id,
      minuteToken,
      hasOwner: Boolean(info.ownerId),
      hasTitle: Boolean(info.title),
      durationMs: Date.now() - startedAt,
    });

    return info;
  } catch (error) {
    const mapped = mapMinuteInfoError(error);

    // The task boundary persists and logs one classified outcome. Do not turn
    // permission denial into null or emit a second generic owner-missing error.
    throw mapped;
  }
}

export function mapMinuteInfoError(error: unknown): MinuteInfoError {
  if (error instanceof MinuteInfoError) return error;
  if (!(error instanceof FeishuOpenApiError)) {
    return new MinuteInfoError('minute_request_failed', '妙记信息暂时获取失败。', true);
  }
  if (error.code === 2091005) {
    return new MinuteInfoError('minute_read_forbidden', '当前集成无权读取妙记，归属未确认，本次未进入分析。', false);
  }
  if (error.code === 2091002 || error.code === 2091004 || error.statusCode === 404) {
    return new MinuteInfoError('minute_unavailable', '妙记不存在或已被删除。', false);
  }
  if (error.code === 2091003) {
    return new MinuteInfoError('minute_not_ready', '妙记尚未就绪，等待重试。', true);
  }
  const retryable = !error.statusCode || error.statusCode === 429 || error.statusCode >= 500;
  return new MinuteInfoError(retryable ? 'minute_request_failed' : 'minute_request_rejected',
    retryable ? '妙记信息暂时获取失败。' : '妙记请求被拒绝，请检查集成授权。', retryable);
}
