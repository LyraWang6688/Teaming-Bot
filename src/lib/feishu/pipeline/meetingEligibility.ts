import type { FeishuIntegrationContext } from '../integration/integrationStore';
import { getLatestFeishuAuthorizationContext } from '../integration/integrationStore';
import { FeishuAuthorizationError } from '../integration/tokenService';
import { fetchMeetingDetails } from '../meetings/meetingDetailsService';
import type { MeetingDetails } from '../meetings/meetingDetailsTypes';
import { fetchMinuteInfo, MinuteInfoError } from '../minutes/minuteInfo';

export type MeetingEligibility =
  | { allowed: true; details: MeetingDetails; ownerOpenId: string }
  | { allowed: false; status: 'skipped' | 'blocked'; reasonCode: string; message: string; ownerOpenId?: string | null };

/** 授权失效统一映射为 blocked（oauth_*），不进入重试——用户重新授权前必然持续失败。 */
function toAuthorizationGate(error: FeishuAuthorizationError): MeetingEligibility {
  return { allowed: false, status: 'blocked', reasonCode: `oauth_${error.code}`, message: error.message };
}

/** These APIs use the SAME integration/app identity; never compare open_ids across apps. */
export async function evaluateMeetingEligibility(
  integration: FeishuIntegrationContext,
  meetingId: string,
  minuteToken: string
): Promise<MeetingEligibility> {
  let details: MeetingDetails;
  try {
    details = await fetchMeetingDetails(integration, meetingId);
  } catch (error) {
    if (error instanceof FeishuAuthorizationError) return toAuthorizationGate(error);
    throw error;
  }
  if (!details.topic) throw new MinuteInfoError('meeting_topic_unavailable', '会议标题暂时不可用。', true);
  if (!details.topic.includes('ABC')) {
    return { allowed: false, status: 'skipped', reasonCode: 'meeting_topic_keyword_mismatch', message: '会议名称不含 ABC，已跳过。' };
  }
  let info;
  try {
    info = await fetchMinuteInfo(minuteToken, integration);
  } catch (error) {
    if (error instanceof FeishuAuthorizationError) return toAuthorizationGate(error);
    if (error instanceof MinuteInfoError && !error.retryable) {
      return { allowed: false, status: 'blocked', reasonCode: error.code, message: error.message };
    }
    throw error;
  }
  if (!info.ownerId) {
    return { allowed: false, status: 'blocked', reasonCode: 'minute_owner_missing', message: '妙记可读取，但未返回所有者身份，本次未进入分析。' };
  }
  const authorization = await getLatestFeishuAuthorizationContext(integration.id);
  if (!authorization?.authorizedOpenId || authorization.status !== 'authorized') {
    return { allowed: false, status: 'blocked', reasonCode: 'integration_authorization_invalid', message: '集成授权身份不可用，请重新授权。' };
  }
  if (info.ownerId !== authorization.authorizedOpenId) {
    return { allowed: false, status: 'skipped', reasonCode: 'minute_not_owner', message: '当前用户不是妙记所有者，已忽略。', ownerOpenId: info.ownerId };
  }
  if (!integration.initializedAt || !integration.selectedOrgTargetId) {
    return { allowed: false, status: 'skipped', reasonCode: 'minute_owner_not_initialized', message: '妙记所有者的集成尚未完成初始化，已跳过。', ownerOpenId: info.ownerId };
  }
  return { allowed: true, details: { ...details, organizerOpenId: info.ownerId }, ownerOpenId: info.ownerId };
}
