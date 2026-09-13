import { FeishuOpenApiError } from '../common/openapi';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { callFeishuIntegrationUserOpenApi } from '../integration/integrationOpenApi';
import { type FeishuIntegrationContext, writeAuditLog } from '../integration/integrationStore';
import { fetchMinuteOwner } from '../minutes/minuteInfo';
import { MeetingDetailsError, type MeetingDetails } from './meetingDetailsTypes';

type RawMeeting = {
  id?: unknown;
  topic?: unknown;
  host_user?: {
    id?: unknown;
  } | null;
};

type MeetingDetailsResponse = {
  meeting?: RawMeeting;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function mapMeetingDetails(
  meetingId: string,
  meeting: RawMeeting
): MeetingDetails {
  return {
    meetingId: asString(meeting.id) || meetingId,
    topic: asString(meeting.topic),
    organizerOpenId: null,
    hostOpenId: asString(meeting.host_user?.id),
  };
}

function mapMeetingDetailsError(error: unknown): Error {
  if (!(error instanceof FeishuOpenApiError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  if (error.code === 121004 || error.statusCode === 404) {
    return new MeetingDetailsError(
      'meeting_not_found',
      '会议不存在，或已经超过飞书支持查询的 90 天范围。',
      { cause: error }
    );
  }

  if (error.code === 121005 || error.statusCode === 403) {
    return new MeetingDetailsError(
      'meeting_access_denied',
      '当前授权用户不能读取该会议详情。',
      { cause: error }
    );
  }

  return error;
}

export async function fetchMeetingDetails(
  integration: FeishuIntegrationContext,
  meetingId: string
): Promise<MeetingDetails> {
  const startedAt = Date.now();
  logFeishuMonitor('info', 'meeting_detail_fetch_started', {
    userId: integration.userId,
    integrationId: integration.id,
    meetingId,
  });

  try {
    const query = new URLSearchParams({
      user_id_type: 'open_id',
      query_mode: '0',
    });
    const response = await callFeishuIntegrationUserOpenApi<MeetingDetailsResponse>(
      integration,
      'GET',
      `/vc/v1/meetings/${encodeURIComponent(meetingId)}?${query.toString()}`
    );

    if (!response.meeting) {
      throw new MeetingDetailsError(
        'meeting_response_invalid',
        '飞书会议详情响应中缺少 meeting 数据。'
      );
    }

    const details = mapMeetingDetails(meetingId, response.meeting);

    await writeAuditLog({
      userId: integration.userId,
      integrationId: integration.id,
      action: 'meeting.details.read',
      result: 'success',
      summary: '读取飞书会议详情',
      metadata: {
        meetingId,
        hasTopic: Boolean(details.topic),
        hasHostOpenId: Boolean(details.hostOpenId),
        durationMs: Date.now() - startedAt,
      },
    });
    logFeishuMonitor('info', 'meeting_detail_fetch_succeeded', {
      userId: integration.userId,
      integrationId: integration.id,
      meetingId,
      hasTopic: Boolean(details.topic),
      hasHostOpenId: Boolean(details.hostOpenId),
      durationMs: Date.now() - startedAt,
    });
    return details;
  } catch (error) {
    const mapped = mapMeetingDetailsError(error);
    await writeAuditLog({
      userId: integration.userId,
      integrationId: integration.id,
      action: 'meeting.details.read',
      result: 'failed',
      summary: '读取飞书会议详情失败',
      metadata: {
        meetingId,
        errorType: mapped.name,
        errorCode: mapped instanceof MeetingDetailsError ? mapped.code : null,
        durationMs: Date.now() - startedAt,
      },
    });
    logFeishuMonitor('error', 'meeting_detail_fetch_failed', {
      userId: integration.userId,
      integrationId: integration.id,
      meetingId,
      stableErrorCode: mapped instanceof MeetingDetailsError ? mapped.code : null,
      durationMs: Date.now() - startedAt,
      ...toErrorContext(mapped),
    });
    throw mapped;
  }
}

/**
 * 组合函数：获取会议详情 + 妙记所有者
 *
 * 先调妙记信息接口取 owner_id（会议创建人），再调 VC API 取会议详情，
 * 合并返回带 organizerOpenId 的 MeetingDetails。
 *
 * organizer 获取失败不阻断流程，organizerOpenId 为 null 时由调用方走门槛兜底分支。
 */
export async function fetchMeetingDetailsWithOrganizer(
  integration: FeishuIntegrationContext,
  meetingId: string,
  minuteToken: string
): Promise<MeetingDetails> {
  const [details, organizerOpenId] = await Promise.all([
    fetchMeetingDetails(integration, meetingId),
    fetchMinuteOwner(minuteToken, integration),
  ]);

  return {
    ...details,
    organizerOpenId,
  };
}
