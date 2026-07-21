import * as lark from '@larksuiteoapi/node-sdk';
import { getFeishuOauthCallbackUrl } from './integrationConfig';
import { logRuntimeMonitor } from '@/lib/platform/runtimeMonitor';
import { writeAuditLog } from './integrationStore';

type FeishuSdkHttpError = Error & {
  response?: {
    status?: number;
    data?: {
      code?: number;
      msg?: string;
      log_id?: string;
      error?: {
        field_violations?: Array<{
          field?: string;
          description?: string;
        }>;
      };
    };
  };
};

type ApplicationSetupStage = 'application_config_patch' | 'application_publish';

function getApplicationConfigErrorContext(
  error: unknown,
  operationStage: ApplicationSetupStage
) {
  const sdkError = error as FeishuSdkHttpError;
  const responseData = sdkError.response?.data;
  return {
    operationStage,
    errorType: error instanceof Error ? error.name : 'UnknownError',
    errorMessage:
      responseData?.msg || (error instanceof Error ? error.message : String(error)),
    errorCode: responseData?.code,
    statusCode: sdkError.response?.status,
    feishuLogId: responseData?.log_id,
    fieldViolations: responseData?.error?.field_violations?.map((violation) => ({
      field: violation.field,
      description: violation.description,
    })),
  };
}

export async function configureFeishuApplication(options: {
  userId: string;
  integrationId: string;
  appId: string;
  appSecret: string;
}): Promise<void> {
  const startedAt = Date.now();
  const client = new lark.Client({
    appId: options.appId,
    appSecret: options.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.error,
    source: 'teaming-meeting-analysis',
  });

  let operationStage: ApplicationSetupStage = 'application_config_patch';

  try {
    const response = await client.application.v7.applicationConfig.patch({
      path: { app_id: options.appId },
      data: {
        event: {
          subscription_type: 'websocket',
        },
        security: {
          add: {
            redirect_urls: [getFeishuOauthCallbackUrl()],
          },
          allow_refresh_token: true,
        },
      },
    });

    if (typeof response.code === 'number' && response.code !== 0) {
      throw new Error(response.msg || '自动配置飞书 OAuth 回调和长连接方式失败。');
    }
    logRuntimeMonitor('info', 'feishu_sdk_setup', 'application_config_patch_succeeded', {
      integrationId: options.integrationId,
      appId: options.appId,
      durationMs: Date.now() - startedAt,
    });

    operationStage = 'application_publish';
    const publishResponse = await client.application.v7.applicationPublish.create({
      path: { app_id: options.appId },
      data: {
        mobile_default_ability: 'bot',
        pc_default_ability: 'bot',
        remark: 'Teaming 会议分析自动配置',
        changelog: '配置 OAuth 回调、Refresh Token 与事件长连接。',
      },
    });
    if (typeof publishResponse.code === 'number' && publishResponse.code !== 0) {
      throw new Error(publishResponse.msg || '飞书应用配置已更新，但自动发布失败。');
    }

    await writeAuditLog({
      userId: options.userId,
      integrationId: options.integrationId,
      action: 'application.config.updated',
      result: 'success',
      summary: 'SDK 自动配置并发布飞书应用',
      metadata: {
        appId: options.appId,
        redirectUrlConfigured: true,
        eventSubscriptionType: 'websocket',
        publishedVersionId: publishResponse.data?.version_id || null,
        publishedVersion: publishResponse.data?.version || null,
      },
    });
    logRuntimeMonitor('info', 'feishu_sdk_setup', 'application_configured', {
      integrationId: options.integrationId,
      appId: options.appId,
      durationMs: Date.now() - startedAt,
      redirectUrlConfigured: true,
      eventSubscriptionType: 'websocket',
      mobileDefaultAbility: 'bot',
      pcDefaultAbility: 'bot',
      publishedVersionId: publishResponse.data?.version_id || null,
      publishedVersion: publishResponse.data?.version || null,
    });
  } catch (error) {
    const errorContext = getApplicationConfigErrorContext(error, operationStage);
    const failedEvent = operationStage === 'application_publish'
      ? 'application_publish_failed'
      : 'application_config_patch_failed';
    await writeAuditLog({
      userId: options.userId,
      integrationId: options.integrationId,
      action: 'application.config.updated',
      result: 'failed',
      summary: 'SDK 自动配置或发布飞书应用失败',
      metadata: {
        appId: options.appId,
        ...errorContext,
      },
    });
    logRuntimeMonitor('error', 'feishu_sdk_setup', failedEvent, {
      integrationId: options.integrationId,
      appId: options.appId,
      durationMs: Date.now() - startedAt,
      ...errorContext,
    });
    throw error;
  }
}
