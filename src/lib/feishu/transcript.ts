import { callFeishuOpenApi } from './openapi';

type DocContentResult = {
  content?: unknown;
};

function collectText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return String(value);

  const record = value as Record<string, unknown>;
  const parts: string[] = [];

  for (const key of ['text', 'content', 'name']) {
    if (typeof record[key] === 'string') {
      parts.push(record[key] as string);
    }
  }

  for (const key of ['children', 'blocks', 'elements']) {
    if (Array.isArray(record[key])) {
      parts.push(collectText(record[key]));
    }
  }

  return parts.filter(Boolean).join('\n');
}

export async function fetchTranscriptByDocToken(docToken: string): Promise<string> {
  const result = await callFeishuOpenApi<DocContentResult>(
    'GET',
    `/docs/v1/documents/${docToken}/content`
  );

  const transcript = collectText(result.content).trim();
  if (!transcript) {
    throw new Error('转录稿文档内容为空');
  }

  return transcript;
}
