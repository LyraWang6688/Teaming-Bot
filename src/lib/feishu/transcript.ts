import {
  callFeishuIntegrationOpenApiTextPreferUser,
  callFeishuIntegrationTenantOpenApi,
  callFeishuIntegrationUserOpenApi,
} from './integrationOpenApi';
import type { FeishuIntegrationContext } from './integrationStore';

type DocRawContentResult = {
  content?: string;
};

export async function fetchTranscriptByDocToken(
  docToken: string,
  integration: FeishuIntegrationContext
): Promise<string> {
  let result: DocRawContentResult | null = null;
  let tenantError: unknown;

  try {
    result = await callFeishuIntegrationUserOpenApi<DocRawContentResult>(
      integration,
      'GET',
      `/docx/v1/documents/${docToken}/raw_content?lang=0`
    );
  } catch (error) {
    tenantError = error;
  }

  if (!result) {
    try {
      result = await callFeishuIntegrationTenantOpenApi<DocRawContentResult>(
        integration,
        'GET',
        `/docx/v1/documents/${docToken}/raw_content?lang=0`
      );
    } catch (error) {
      throw tenantError || error;
    }
  }

  const transcript = (result.content || '').trim();
  if (!transcript) {
    throw new Error('转录稿文档内容为空');
  }

  return transcript;
}

export async function fetchTranscriptByMinuteToken(
  minuteToken: string,
  integration: FeishuIntegrationContext
): Promise<string> {
  const text = await callFeishuIntegrationOpenApiTextPreferUser(
    integration,
    'GET',
    `/minutes/v1/minutes/${minuteToken}/transcript?need_speaker=true&need_timestamp=true&file_format=txt`
  );
  const transcript = text.trim();
  if (!transcript) {
    throw new Error('妙记文字稿内容为空');
  }

  return transcript;
}
