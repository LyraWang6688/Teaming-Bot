import {
  callFeishuIntegrationUserCliOpenApi,
  downloadFeishuIntegrationUserCliOpenApiFile,
} from '../integration/integrationOpenApi';
import type { FeishuIntegrationContext } from '../integration/integrationStore';
import { mkdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

type DocRawContentResult = {
  content?: string;
};

export async function fetchTranscriptByDocToken(
  docToken: string,
  integration: FeishuIntegrationContext
): Promise<string> {
  const result = await callFeishuIntegrationUserCliOpenApi<DocRawContentResult>(
    integration,
    'GET',
    `/docx/v1/documents/${docToken}/raw_content?lang=0`
  );

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
  const outputDir = join(tmpdir(), 'teaming-bot-minutes');
  await mkdir(outputDir, { recursive: true });

  const outputFileName = `${minuteToken}-${randomUUID()}.txt`;
  const outputPath = join(outputDir, outputFileName);

  try {
    await downloadFeishuIntegrationUserCliOpenApiFile(
      integration,
      'GET',
      `/minutes/v1/minutes/${minuteToken}/transcript?need_speaker=true&need_timestamp=true&file_format=txt`,
      outputFileName,
      outputDir
    );

    const text = await readFile(outputPath, 'utf-8');
    const transcript = text.trim();
    if (!transcript) {
      throw new Error('妙记文字稿内容为空');
    }

    return transcript;
  } finally {
    await rm(outputPath, { force: true });
  }
}
