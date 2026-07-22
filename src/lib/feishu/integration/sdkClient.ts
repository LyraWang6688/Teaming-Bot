import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuIntegrationContext } from './integrationStore';

export function createFeishuSdkClient(
  integration: Pick<FeishuIntegrationContext, 'appId' | 'secrets'>
): lark.Client {
  return new lark.Client({
    appId: integration.appId,
    appSecret: integration.secrets.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.error,
    source: 'teaming-meeting-analysis',
  });
}
