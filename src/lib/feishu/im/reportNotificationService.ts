import { assertPublicReportUrl, assertServerRuntimeEnabled } from '@/lib/platform/serverRuntime';
import { maskSecret } from '@/lib/security/crypto';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { createFeishuSdkClient } from '../integration/sdkClient';
import type { FeishuIntegrationContext } from '../integration/integrationStore';

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

/**
 * 发送报告卡片消息（幂等）。
 *
 * idempotencyKey 是交付任务创建时固定的确定性键
 * （meeting_record_id + report_revision + recipient），
 * 所有重试与崩溃恢复复用同一键；飞书侧按 uuid 去重，避免超时重发导致重复消息。
 *
 * 本函数只负责「发」，不做接收人决策、不写任务状态——那些在
 * delivery/notificationProcessor.ts 中完成。
 */
export async function sendReportCardToRecipient(options: {
  integration: FeishuIntegrationContext;
  recipientOpenId: string;
  meetingName: string | null;
  reportUrl: string;
  idempotencyKey: string;
}): Promise<{ messageId: string | null; durationMs: number }> {
  const { integration, recipientOpenId, meetingName, reportUrl, idempotencyKey } = options;
  assertServerRuntimeEnabled();
  assertPublicReportUrl(reportUrl);
  const startedAt = Date.now();
  const maskedRecipientOpenId = maskSecret(recipientOpenId);

  logFeishuMonitor('info', 'report_notification_started', {
    integrationId: integration.id,
    reportUrl,
    recipientOpenId: maskedRecipientOpenId,
    idempotencyKey,
  });

  const client = createFeishuSdkClient(integration);
  // 飞书 OpenAPI 支持 uuid 查询参数做请求去重；SDK 类型定义暂未包含该字段，
  // 用变量承载以绕过对象字面量多余属性检查（运行时仍会带上 uuid）。
  const requestParams = {
    receive_id_type: 'open_id' as const,
    uuid: idempotencyKey,
  };
  const response = await client.im.message.create({
    params: requestParams,
    data: {
      receive_id: recipientOpenId,
      msg_type: 'interactive',
      content: buildReportCardContent({
        meetingName,
        reportUrl,
      }),
    },
  });

  if (typeof response.code === 'number' && response.code !== 0) {
    const error = new Error(response.msg || '飞书消息发送失败') as Error & {
      feishuCode?: number;
    };
    error.feishuCode = response.code;
    throw error;
  }

  const messageId = response.data?.message_id || null;
  const durationMs = Date.now() - startedAt;

  logFeishuMonitor('info', 'report_notification_succeeded', {
    integrationId: integration.id,
    recipientOpenId: maskedRecipientOpenId,
    messageId,
    idempotencyKey,
    durationMs,
  });

  return { messageId, durationMs };
}

/** 调用方兜底用：把发送失败统一成可记录的上下文 */
export function notificationErrorContext(error: unknown) {
  return toErrorContext(error instanceof Error ? error : new Error(String(error)));
}
