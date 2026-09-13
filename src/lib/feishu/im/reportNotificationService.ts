import { maskSecret } from '@/lib/security/crypto';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { createFeishuSdkClient } from '../integration/sdkClient';
import {
  type FeishuIntegrationContext,
  writeAuditLog,
} from '../integration/integrationStore';

function buildReportCardContent(options: {
  meetingName: string | null;
  reportUrl: string;
}): string {
  const { meetingName, reportUrl } = options;
  const detailLines = meetingName ? [`**会议名称：**${meetingName}`] : ['会议报告已生成'];

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
        content: detailLines.join('\n'),
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
  meetingName: string | null;
  recordId: string;
  reportUrl: string;
  organizerOpenId: string | null;
}): Promise<{ messageId: string | null; durationMs: number }> {
  const {
    integration,
    meetingId,
    meetingName,
    recordId,
    reportUrl,
    organizerOpenId,
  } = options;
  const startedAt = Date.now();
  const maskedOrganizerOpenId = maskSecret(organizerOpenId);

  logFeishuMonitor('info', 'report_notification_started', {
    integrationId: integration.id,
    meetingId,
    recordId,
    reportUrl,
    organizerOpenId: maskedOrganizerOpenId,
  });

  if (!organizerOpenId) {
    const error = new Error('缺少会议创建人 open_id，无法发送会议报告通知。');
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
        organizerOpenId: maskedOrganizerOpenId,
        reason: 'organizer_open_id_missing',
      },
    });
    logFeishuMonitor('error', 'report_notification_failed', {
      integrationId: integration.id,
      meetingId,
      recordId,
      reportUrl,
      organizerOpenId: maskedOrganizerOpenId,
      reason: 'organizer_open_id_missing',
      durationMs: Date.now() - startedAt,
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
        receive_id: organizerOpenId,
        msg_type: 'interactive',
        content: buildReportCardContent({
          meetingName,
          reportUrl,
        }),
      },
    });

    if (typeof response.code === 'number' && response.code !== 0) {
      throw new Error(response.msg || '飞书消息发送失败');
    }

    const messageId = response.data?.message_id || null;
    const durationMs = Date.now() - startedAt;

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
        organizerOpenId: maskedOrganizerOpenId,
        messageId,
      },
    });

    logFeishuMonitor('info', 'report_notification_succeeded', {
      integrationId: integration.id,
      meetingId,
      recordId,
      reportUrl,
      organizerOpenId: maskedOrganizerOpenId,
      messageId,
      durationMs,
    });
    return {
      messageId,
      durationMs,
    };
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
        organizerOpenId: maskedOrganizerOpenId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
    });

    logFeishuMonitor('error', 'report_notification_failed', {
      integrationId: integration.id,
      meetingId,
      recordId,
      reportUrl,
      organizerOpenId: maskedOrganizerOpenId,
      durationMs: Date.now() - startedAt,
      ...toErrorContext(error),
    });
    throw error;
  }
}
