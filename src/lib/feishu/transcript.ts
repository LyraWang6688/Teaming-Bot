import {
  callFeishuOpenApi,
  callFeishuOpenApiText,
  callFeishuUserOpenApi,
  callFeishuUserOpenApiText,
} from './openapi';

type DocRawContentResult = {
  content?: string;
};

export async function fetchTranscriptByDocToken(docToken: string): Promise<string> {
  let result: DocRawContentResult | null = null;
  let tenantError: unknown;

  try {
    result = await callFeishuUserOpenApi<DocRawContentResult>(
      'GET',
      `/docx/v1/documents/${docToken}/raw_content?lang=0`
    );
  } catch (error) {
    tenantError = error;
  }

  if (!result) {
    try {
      result = await callFeishuOpenApi<DocRawContentResult>(
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

export async function fetchTranscriptByMinuteToken(minuteToken: string): Promise<string> {
  let text = '';
  let userError: unknown;

  try {
    text = await callFeishuUserOpenApiText(
      'GET',
      `/minutes/v1/minutes/${minuteToken}/transcript?need_speaker=true&need_timestamp=true&file_format=txt`
    );
  } catch (error) {
    userError = error;
  }

  if (!text) {
    try {
      text = await callFeishuOpenApiText(
        'GET',
        `/minutes/v1/minutes/${minuteToken}/transcript?need_speaker=true&need_timestamp=true&file_format=txt`
      );
    } catch (error) {
      throw userError || error;
    }
  }

  const transcript = text.trim();
  if (!transcript) {
    throw new Error('妙记文字稿内容为空');
  }

  return transcript;
}
