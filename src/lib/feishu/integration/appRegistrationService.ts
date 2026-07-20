import {
  claimAppRegistrationFinalization,
  failAppRegistrationFinalization,
  finishAppRegistrationFinalization,
  getAppRegistrationTask,
  recordAppRegistrationIntegration,
} from './appRegistrationStore';
import { configureFeishuApplication } from './applicationConfigService';
import {
  createUserFeishuIntegration,
  getUserFeishuIntegrationDetail,
  upsertFeishuIntegrationCheckStatus,
  writeAuditLog,
  type FeishuIntegrationDetail,
} from './integrationStore';
import { FEISHU_REQUIRED_USER_SCOPE } from './integrationConstants';

export async function finalizeAppRegistration(
  sessionToken: string
): Promise<FeishuIntegrationDetail | null> {
  const existingTask = getAppRegistrationTask(sessionToken);
  if (!existingTask) return null;

  if (existingTask.status === 'finalized' && existingTask.integrationId) {
    return getUserFeishuIntegrationDetail(existingTask.userId, existingTask.integrationId);
  }

  const task = claimAppRegistrationFinalization(sessionToken);
  if (!task?.result) return null;

  try {
    const integration = task.integrationId
      ? await getUserFeishuIntegrationDetail(task.userId, task.integrationId)
      : await createUserFeishuIntegration({
          userId: task.userId,
          name: `Teaming-Bot-${sessionToken.slice(0, 8)}`,
          appId: task.result.appId,
          appSecret: task.result.appSecret,
          oauthScope: FEISHU_REQUIRED_USER_SCOPE,
        });
    if (!integration) {
      throw new Error('已创建的飞书集成记录不存在，请重新发起。');
    }
    recordAppRegistrationIntegration(sessionToken, integration.id);

    await configureFeishuApplication({
      userId: task.userId,
      integrationId: integration.id,
      appId: task.result.appId,
      appSecret: task.result.appSecret,
    });
    await upsertFeishuIntegrationCheckStatus({
      integrationId: integration.id,
      appCredentialStatus: 'success',
      oauthStatus: 'pending',
      baseStatus: 'pending',
      permissionStatus: 'pending',
      eventSubscriptionStatus: 'pending',
      lastErrorType: null,
      lastErrorMessage: null,
      details: {
        appRegistration: {
          provider: 'node_sdk',
          applicationConfigured: true,
        },
      },
    });
    await writeAuditLog({
      userId: task.userId,
      integrationId: integration.id,
      action: 'integration.app_registration.completed',
      result: 'success',
      summary: 'SDK 一键创建并配置飞书应用',
      metadata: {
        appId: task.result.appId,
        creatorOpenId: task.result.creatorOpenId,
      },
    });

    finishAppRegistrationFinalization(sessionToken, integration.id);
    return getUserFeishuIntegrationDetail(task.userId, integration.id);
  } catch (error) {
    failAppRegistrationFinalization(sessionToken, error);
    throw error;
  }
}
