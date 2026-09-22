import { createSafeFeishuSdkLogger } from '@/lib/feishu/common/sdkLogger';
import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuIntegrationContext } from './integrationStore';
import { getFeishuBaseAppId, getFeishuBaseAppSecret } from '@/lib/platform/env';

export function createFeishuSdkClient(
  integration: Pick<FeishuIntegrationContext, 'appId' | 'secrets'>,
  requestErrorsHandled = false
): lark.Client {
  return new lark.Client({
    appId: integration.appId,
    appSecret: integration.secrets.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.error,
    logger: createSafeFeishuSdkLogger(requestErrorsHandled),
    source: 'teaming-meeting-analysis',
  });
}

// 全局 Base 读写 SDK 客户端：单例，所有项目共享。
// 凭证来自平台级环境变量，与集成应用相互独立。
let globalBaseAppClient: lark.Client | null = null;

export function getGlobalBaseAppSdkClient(): lark.Client {
  if (!globalBaseAppClient) {
    globalBaseAppClient = new lark.Client({
      appId: getFeishuBaseAppId(),
      appSecret: getFeishuBaseAppSecret(),
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
      logger: createSafeFeishuSdkLogger(true),
      source: 'teaming-meeting-analysis',
    });
  }
  return globalBaseAppClient;
}
