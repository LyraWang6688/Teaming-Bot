import { callFeishuIntegrationUserOpenApi } from '../integration/integrationOpenApi';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
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

/**
 * 获取妙记所有者 open_id（会议创建人）
 *
 * 飞书定义：云录制文件归属者 = 日程组织者（预约会议）或会议发起人（临时会议），
 * 语义上即"会议创建人"，用于触发门槛判断。
 *
 * 接口：GET /minutes/v1/minutes/:minute_token?user_id_type=open_id
 */
export async function fetchMinuteOwner(
  minuteToken: string,
  integration: FeishuIntegrationContext
): Promise<string | null> {
  const info = await fetchMinuteInfo(minuteToken, integration);
  return info?.ownerId ?? null;
}

/**
 * 获取妙记完整信息
 *
 * 用于门槛判断（owner_id）和会议元数据补全（title、noteId 等）。
 */
export async function fetchMinuteInfo(
  minuteToken: string,
  integration: FeishuIntegrationContext
): Promise<MinuteInfo | null> {
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
      `/minutes/v1/minutes/${encodeURIComponent(minuteToken)}?${query.toString()}`
    );

    if (!response.minute) {
      logFeishuMonitor('warn', 'minute_info_response_empty', {
        userId: integration.userId,
        integrationId: integration.id,
        minuteToken,
        durationMs: Date.now() - startedAt,
      });
      return null;
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

    await writeAuditLog({
      userId: integration.userId,
      integrationId: integration.id,
      action: 'minute.info.read',
      result: 'failed',
      summary: '读取妙记信息失败',
      metadata: {
        minuteToken,
        errorType: mapped.name,
        durationMs: Date.now() - startedAt,
      },
    });

    logFeishuMonitor('error', 'minute_info_fetch_failed', {
      userId: integration.userId,
      integrationId: integration.id,
      minuteToken,
      durationMs: Date.now() - startedAt,
      ...toErrorContext(mapped),
    });

    // 妙记信息获取失败不阻断主流程，返回 null 让门槛判断走兜底分支
    return null;
  }
}

function mapMinuteInfoError(error: unknown): Error {
  if (!(error instanceof FeishuOpenApiError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  if (error.code === 2091002 || error.statusCode === 404) {
    return new Error('妙记不存在或已被删除。');
  }

  if (error.code === 2091003) {
    return new Error('妙记转写尚未完成，请稍后重试。');
  }

  if (error.code === 2091005 || error.statusCode === 403) {
    return new Error('当前授权用户没有该妙记的读取权限。');
  }

  return error;
}
