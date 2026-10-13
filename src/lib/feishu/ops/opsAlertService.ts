/**
 * 运维告警推送。
 *
 * ## 为什么用「平台级应用」而不是用户的应用
 *
 * 告警通道有一条铁律：**不能用被监控的那条链路去告警**。
 *
 * 2026-10-13 事故就是反例：系统想提醒用户"授权失效，请重新授权"，
 * 但发提醒用的正是那个失效/被管控策略拒绝的应用 → 卡片发不出去 →
 * 用户不知道 → 没人重新授权 → 故障自行扩大。
 *
 * 所以这里走**平台级应用**（`FEISHU_BASE_APP_ID` / `FEISHU_BASE_APP_SECRET`），
 * 它独立于每个用户创建的集成应用，不会因为某个用户的授权过期而哑掉。
 *
 * ## 兜底：审计表
 *
 * 推送可能失败（平台应用自身被限、网络问题、未配置收件人）。
 * 因此每次扫描都会**无条件写审计表**——推送哑了也能事后查。
 *
 * ## 配置
 *
 * - `OPS_ALERT_CHAT_ID`（oc_...，推荐，群或个人会话）
 * - 或 `OPS_ALERT_OPEN_ID`（ou_...，个人）
 *
 * 两者都没配 → 只写日志和审计表，不推送。
 */

import { callGlobalBaseAppTenantOpenApi } from '../integration/integrationOpenApi';
import { logFeishuMonitor, toErrorContext } from '../common/monitor';

export type OpsAlertResult = { sent: boolean; reason: string };

function readRecipient(): { receiveId: string; receiveIdType: 'chat_id' | 'open_id' } | null {
  const chatId = (process.env.OPS_ALERT_CHAT_ID || '').trim();
  if (chatId.startsWith('oc_')) return { receiveId: chatId, receiveIdType: 'chat_id' };

  const openId = (process.env.OPS_ALERT_OPEN_ID || '').trim();
  if (openId.startsWith('ou_')) return { receiveId: openId, receiveIdType: 'open_id' };

  return null;
}

export function isOpsAlertConfigured(): boolean {
  return readRecipient() !== null;
}

/**
 * 发送一条运维告警。
 *
 * **永不抛错**——告警失败不能影响业务扫描本身。
 */
export async function sendOpsAlert(params: {
  title: string;
  markdown: string;
  /** 幂等键，避免同一轮扫描重复推送 */
  idempotencyKey?: string;
}): Promise<OpsAlertResult> {
  const recipient = readRecipient();
  if (!recipient) {
    logFeishuMonitor('warn', 'ops_alert_skipped_not_configured', {
      hint: '未配置 OPS_ALERT_CHAT_ID 或 OPS_ALERT_OPEN_ID，本次只写审计表。',
    });
    return { sent: false, reason: 'not_configured' };
  }

  try {
    await callGlobalBaseAppTenantOpenApi(
      'POST',
      `/open-apis/im/v1/messages?receive_id_type=${recipient.receiveIdType}`,
      {
        receive_id: recipient.receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(buildAlertCard(params.title, params.markdown)),
      }
    );
    logFeishuMonitor('info', 'ops_alert_sent', { title: params.title });
    return { sent: true, reason: 'sent' };
  } catch (error) {
    // 平台应用自己也可能被限（例如同样的管控策略），此时只能靠审计表
    logFeishuMonitor('error', 'ops_alert_send_failed', {
      title: params.title,
      ...toErrorContext(error),
    });
    return { sent: false, reason: 'send_failed' };
  }
}

/** 极简卡片：标题 + 正文，与线上交付形态一致 */
export function buildAlertCard(title: string, markdown: string) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: title },
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: markdown } }],
  };
}
