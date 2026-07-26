import { maskSecret } from '@/lib/security/crypto';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { createFeishuSdkClient } from '../integration/sdkClient';
import {
  getLatestFeishuAuthorization,
  type FeishuIntegrationContext,
  writeAuditLog,
} from '../integration/integrationStore';

const REPORT_TIME_ZONE = 'Asia/Shanghai';

function formatMeetingDateTime(value: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function formatMeetingTime(startedAt: Date | null, endedAt: Date | null): string {
  if (startedAt && endedAt) {
    return `${formatMeetingDateTime(startedAt)}–${formatMeetingDateTime(endedAt)}`;
  }
  if (startedAt || endedAt) {
    return formatMeetingDateTime((startedAt || endedAt) as Date);
  }
  return '时间待同步';
}

function buildReportCardContent(options: {
  meetingName: string;
  startedAt: Date | null;
  endedAt: Date | null;
  reportUrl: string;
}): string {
  const { meetingName, startedAt, endedAt, reportUrl } = options;
  return JSON.stringify({
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: '小组会议动力分析报告 已出炉',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**会议名称：**${meetingName}`,
          `**会议时间：**${formatMeetingTime(startedAt, endedAt)}`,
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: {
              tag: 'plain_text',
              content: '点击查看报告',
            },
            url: reportUrl,
          },
        ],
      },
    ],
  });
}

export async function sendMeetingReportNotification(options: {
  integration: FeishuIntegrationContext;
  meetingId: string;
  meetingName: string;
  startedAt: Date | null;
  endedAt: Date | null;
  recordId: string;
  reportUrl: string;
}): Promise<void> {
  const {
    integration,
    meetingId,
    meetingName,
    startedAt,
    endedAt,
    recordId,
    reportUrl,
  } = options;
  const authorization = await getLatestFeishuAuthorization(integration.id);
  const authorizedOpenId = authorization?.authorizedOpenId || null;
  const maskedAuthorizedOpenId = maskSecret(authorizedOpenId);

  logFeishuMonitor('info', 'report_notification_started', {
    integrationId: integration.id,
    meetingId,
    recordId,
    reportUrl,
    authorizedOpenId: maskedAuthorizedOpenId,
  });

  if (!authorization || authorization.status !== 'authorized' || !authorizedOpenId) {
    const error = new Error('当前集成缺少可用的授权用户 open_id，无法发送会议报告通知。');
    await writeAuditLog({
      userId: integration.userId,
      integrationId: integration.id,
      action: 'meeting.report.notification.send',
      result: 'failed',
      summary: '发送会议报告通知失败',
      metadata: {
        meetingId,
        recordId,
        reportUrl,
        authorizedOpenId: maskedAuthorizedOpenId,
        reason: 'authorized_open_id_missing',
      },
    });
    logFeishuMonitor('error', 'report_notification_failed', {
      integrationId: integration.id,
      meetingId,
      recordId,
      reportUrl,
      authorizedOpenId: maskedAuthorizedOpenId,
      reason: 'authorized_open_id_missing',
      ...toErrorContext(error),
    });
    throw error;
  }

  const client = createFeishuSdkClient(integration);

  try {
    const response = await client.im.message.create({
      params: {
        receive_id_type: 'open_id',
      },
      data: {
        receive_id: authorizedOpenId,
        msg_type: 'interactive',
        content: buildReportCardContent({
          meetingName,
          startedAt,
          endedAt,
          reportUrl,
        }),
      },
    });

    if (typeof response.code === 'number' && response.code !== 0) {
      throw new Error(response.msg || '飞书消息发送失败');
    }

    await writeAuditLog({
      userId: integration.userId,
      integrationId: integration.id,
      action: 'meeting.report.notification.send',
      result: 'success',
      summary: '发送会议报告通知成功',
      metadata: {
        meetingId,
        recordId,
        reportUrl,
        authorizedOpenId: maskedAuthorizedOpenId,
        messageId: response.data?.message_id || null,
      },
    });

    logFeishuMonitor('info', 'report_notification_succeeded', {
      integrationId: integration.id,
      meetingId,
      recordId,
      reportUrl,
      authorizedOpenId: maskedAuthorizedOpenId,
      messageId: response.data?.message_id || null,
    });
  } catch (error) {
    await writeAuditLog({
      userId: integration.userId,
      integrationId: integration.id,
      action: 'meeting.report.notification.send',
      result: 'failed',
      summary: '发送会议报告通知失败',
      metadata: {
        meetingId,
        recordId,
        reportUrl,
        authorizedOpenId: maskedAuthorizedOpenId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
    });

    logFeishuMonitor('error', 'report_notification_failed', {
      integrationId: integration.id,
      meetingId,
      recordId,
      reportUrl,
      authorizedOpenId: maskedAuthorizedOpenId,
      ...toErrorContext(error),
    });
    throw error;
  }
}
