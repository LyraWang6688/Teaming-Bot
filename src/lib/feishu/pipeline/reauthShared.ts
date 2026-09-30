/**
 * 授权失效提醒与自动补发的纯函数辅助（不依赖数据库，便于隔离测试）。
 */

/** 资格检查中授权失效类 reasonCode 的前缀（oauth_refresh_token_expired 等）。 */
export const REAUTH_GATE_REASON_PREFIX = 'oauth_';
/** 授权记录状态不可用（如重启校验后被标记 reauthorization_required）时的既有 reasonCode。 */
export const REAUTH_GATE_REASON_LEGACY = 'integration_authorization_invalid';

export function isReauthorizationGateReason(reasonCode: string | null | undefined): boolean {
  return Boolean(
    reasonCode &&
    (reasonCode.startsWith(REAUTH_GATE_REASON_PREFIX) || reasonCode === REAUTH_GATE_REASON_LEGACY)
  );
}

/** 自动补发窗口：飞书会议详情接口官方时效 90 天，预留 5 天余量。 */
export const REAUTH_RESUME_WINDOW_DAYS = 85;

export function isWithinResumeWindow(
  eventReceivedAt: string | null | undefined,
  fallbackAt: Date,
  now = Date.now()
): boolean {
  const parsed = eventReceivedAt ? Date.parse(eventReceivedAt) : NaN;
  const reference = Number.isFinite(parsed) ? parsed : fallbackAt.getTime();
  if (!Number.isFinite(reference)) return false;
  return now - reference <= REAUTH_RESUME_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/** 提醒文案中的事件日期（北京时间），无事件时间时退回通用表述。 */
export function formatReminderEventDate(eventReceivedAt: string | null | undefined, now = new Date()): string {
  const parsed = eventReceivedAt ? Date.parse(eventReceivedAt) : NaN;
  const date = Number.isFinite(parsed) ? new Date(parsed) : now;
  return date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}
