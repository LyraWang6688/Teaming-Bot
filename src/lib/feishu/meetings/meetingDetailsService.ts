import { FeishuOpenApiError } from '../common/openapi';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { callFeishuIntegrationUserOpenApi } from '../integration/integrationOpenApi';
import {
  getLatestFeishuAuthorization,
  type FeishuIntegrationContext,
  writeAuditLog,
} from '../integration/integrationStore';
import {
  MEETING_DETAIL_STATUS,
  MeetingDetailsError,
  type MeetingDetails,
  type MeetingDetailStatus,
} from './meetingDetailsTypes';

type RawMeetingUser = {
  id?: unknown;
};

type RawMeeting = {
  id?: unknown;
  topic?: unknown;
  url?: unknown;
  status?: unknown;
  create_time?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  host_user?: RawMeetingUser;
  note_id?: unknown;
};

type MeetingDetailsResponse = {
  meeting?: RawMeeting;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function fromUnixSeconds(value: unknown): Date | null {
  const normalized =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(normalized) || normalized <= 0) {
    return null;
  }

  const date = new Date(normalized * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapMeetingStatus(value: unknown): MeetingDetailStatus {
  const normalized = typeof value === 'number' ? value : Number(value);
  if (normalized === 1) return MEETING_DETAIL_STATUS.calling;
  if (normalized === 2) return MEETING_DETAIL_STATUS.ongoing;
  if (normalized === 3) return MEETING_DETAIL_STATUS.ended;
  return MEETING_DETAIL_STATUS.unknown;
}

function mapMeetingDetails(
  meetingId: string,
  meeting: RawMeeting,
  authorizedOpenId: string | null,
  authorizedUserName: string | null
): MeetingDetails {
  const hostOpenId = asString(meeting.host_user?.id);

  return {
    meetingId: asString(meeting.id) || meetingId,
    topic: asString(meeting.topic),
    meetingUrl: asString(meeting.url),
    status: mapMeetingStatus(meeting.status),
    createdAt: fromUnixSeconds(meeting.create_time),
    startedAt: fromUnixSeconds(meeting.start_time),
    endedAt: fromUnixSeconds(meeting.end_time),
    hostOpenId,
    hostName:
      hostOpenId && authorizedOpenId && hostOpenId === authorizedOpenId
        ? authorizedUserName
        : null,
    noteId: asString(meeting.note_id),
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
      with_participants: 'false',
      with_meeting_ability: 'false',
      user_id_type: 'open_id',
      query_mode: '0',
    });
    const [response, authorization] = await Promise.all([
      callFeishuIntegrationUserOpenApi<MeetingDetailsResponse>(
        integration,
        'GET',
        `/vc/v1/meetings/${encodeURIComponent(meetingId)}?${query.toString()}`
      ),
      getLatestFeishuAuthorization(integration.id),
    ]);

    if (!response.meeting) {
      throw new MeetingDetailsError(
        'meeting_response_invalid',
        '飞书会议详情响应中缺少 meeting 数据。'
      );
    }

    const details = mapMeetingDetails(
      meetingId,
      response.meeting,
      authorization?.authorizedOpenId || null,
      authorization?.authorizedUserName || null
    );

    await writeAuditLog({
      userId: integration.userId,
      integrationId: integration.id,
      action: 'meeting.details.read',
      result: 'success',
      summary: '读取飞书会议详情',
      metadata: {
        meetingId,
        hasTopic: Boolean(details.topic),
        hasMeetingTime: Boolean(details.startedAt || details.endedAt),
        hasResolvedHostName: Boolean(details.hostName),
        durationMs: Date.now() - startedAt,
      },
    });
    logFeishuMonitor('info', 'meeting_detail_fetch_succeeded', {
      userId: integration.userId,
      integrationId: integration.id,
      meetingId,
      hasTopic: Boolean(details.topic),
      hasMeetingTime: Boolean(details.startedAt || details.endedAt),
      hasResolvedHostName: Boolean(details.hostName),
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
