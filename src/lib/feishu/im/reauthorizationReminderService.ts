/**
 * 授权失效提醒与授权成功确认（应用机器人身份发送，与用户 token 失效无关）。
 *
 * 触发：会议任务因授权失效（oauth_* / integration_authorization_invalid）进入 blocked。
 * 去重：同一失效周期只提醒一次——提醒时间记录在 checks.details.reauthReminderSentAt；
 *       重新授权成功后 checks.details 被重置，下一失效周期可再次提醒。
 * 截止：仅 active 项目发送；archived 项目静默。
 */
import { getProjectPublicUrl } from '@/lib/platform/env';
import { assertServerRuntimeEnabled } from '@/lib/platform/serverRuntime';
import { maskSecret } from '@/lib/security/crypto';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';
import { createReauthToken } from '../integration/reauthToken';
import { createFeishuSdkClient } from '../integration/sdkClient';
import {
  getFeishuIntegrationCheckStatus,
  getLatestFeishuAuthorizationContext,
  upsertFeishuIntegrationCheckStatus,
  writeAuditLog,
  type FeishuIntegrationContext,
} from '../integration/integrationStore';
import { getFeishuProjectById } from '../projects/projectConfigStore';
import { formatReminderEventDate } from '../pipeline/reauthShared';

const REMINDER_DETAILS_KEY = 'reauthReminderSentAt';

function buildReminderCardContent(options: { eventDate: string; reauthUrl: string }): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '会议分析授权已过期' },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `你在 **${options.eventDate}** 有一场会议已结束，但未能生成分析报告。`,
          '',
          '**原因：**你的飞书授权已过期（连续 7 天未使用会自动失效）。',
          '',
          '授权成功后，系统会自动补发这场会议的分析报告。',
          '请在 90 天内完成授权，逾期将无法补发。',
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: '重新授权（只需几秒钟）' },
            url: options.reauthUrl,
          },
        ],
      },
    ],
  });
}

function buildReauthSuccessCardContent(): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '✅ 授权成功' },
    },
    elements: [
      {
        tag: 'markdown',
        content: '你之前的会议报告正在补发中，稍后推送给你。',
      },
    ],
  });
}

async function sendCardToAuthorizedUser(options: {
  integration: FeishuIntegrationContext;
  recipientOpenId: string;
  content: string;
  idempotencyKey: string;
}): Promise<void> {
  const client = createFeishuSdkClient(options.integration);
  // 飞书 OpenAPI 支持 uuid 查询参数做请求去重；SDK 类型定义暂未包含该字段，
  // 用变量承载以绕过对象字面量多余属性检查（与 reportNotificationService 相同）。
  const requestParams = {
    receive_id_type: 'open_id' as const,
    uuid: options.idempotencyKey,
  };
  const response = await client.im.message.create({
    params: requestParams,
    data: {
      receive_id: options.recipientOpenId,
      msg_type: 'interactive',
      content: options.content,
    },
  });
  if (typeof response.code === 'number' && response.code !== 0) {
    throw new Error(response.msg || '飞书消息发送失败');
  }
}

export async function maybeSendReauthorizationReminder(options: {
  integration: FeishuIntegrationContext;
  eventReceivedAt?: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const { integration } = options;
  assertServerRuntimeEnabled();

  if (!integration.projectId) {
    logFeishuMonitor('info', 'reauth_reminder_skipped', { integrationId: integration.id, reason: 'project_missing' });
    return { sent: false, reason: 'project_missing' };
  }
  const project = await getFeishuProjectById(integration.projectId);
  if (!project || project.status !== 'active') {
    logFeishuMonitor('info', 'reauth_reminder_skipped', { integrationId: integration.id, reason: 'project_not_active' });
    return { sent: false, reason: 'project_not_active' };
  }

  const authorization = await getLatestFeishuAuthorizationContext(integration.id);
  if (!authorization?.authorizedOpenId) {
    logFeishuMonitor('warn', 'reauth_reminder_skipped', { integrationId: integration.id, reason: 'recipient_missing' });
    return { sent: false, reason: 'recipient_missing' };
  }

  const checks = await getFeishuIntegrationCheckStatus(integration.id);
  if (checks?.details?.[REMINDER_DETAILS_KEY]) {
    return { sent: false, reason: 'already_sent_in_episode' };
  }

  const reauthUrl = `${getProjectPublicUrl()}/api/feishu/reauth/start?t=${createReauthToken(integration.id)}`;
  const eventDate = formatReminderEventDate(options.eventReceivedAt);
  const startedAt = Date.now();

  try {
    await sendCardToAuthorizedUser({
      integration,
      recipientOpenId: authorization.authorizedOpenId,
      content: buildReminderCardContent({ eventDate, reauthUrl }),
      idempotencyKey: `reauth-reminder-${integration.id}-${eventDate}`,
    });
  } catch (error) {
    logFeishuMonitor('warn', 'reauth_reminder_failed', {
      integrationId: integration.id,
      recipientOpenId: maskSecret(authorization.authorizedOpenId),
      ...toErrorContext(error),
    });
    return { sent: false, reason: 'send_failed' };
  }

  await upsertFeishuIntegrationCheckStatus({
    integrationId: integration.id,
    details: { ...(checks?.details || {}), [REMINDER_DETAILS_KEY]: new Date().toISOString() },
  });
  await writeAuditLog({
    userId: integration.userId,
    integrationId: integration.id,
    action: 'oauth.reauth.reminder_sent',
    result: 'success',
    summary: '已向用户推送授权失效提醒',
    metadata: { eventDate, durationMs: Date.now() - startedAt },
  });
  logFeishuMonitor('info', 'reauth_reminder_sent', {
    integrationId: integration.id,
    recipientOpenId: maskSecret(authorization.authorizedOpenId),
    durationMs: Date.now() - startedAt,
  });
  return { sent: true };
}

export async function sendReauthorizationSuccessCard(options: {
  integration: FeishuIntegrationContext;
  recipientOpenId: string;
}): Promise<void> {
  const { integration } = options;
  assertServerRuntimeEnabled();
  try {
    await sendCardToAuthorizedUser({
      integration,
      recipientOpenId: options.recipientOpenId,
      content: buildReauthSuccessCardContent(),
      idempotencyKey: `reauth-success-${integration.id}-${Date.now()}`,
    });
    logFeishuMonitor('info', 'reauth_success_card_sent', {
      integrationId: integration.id,
      recipientOpenId: maskSecret(options.recipientOpenId),
    });
  } catch (error) {
    logFeishuMonitor('warn', 'reauth_success_card_failed', {
      integrationId: integration.id,
      recipientOpenId: maskSecret(options.recipientOpenId),
      ...toErrorContext(error),
    });
  }
}
