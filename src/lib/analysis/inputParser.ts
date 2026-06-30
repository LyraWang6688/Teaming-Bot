import { NextRequest } from 'next/server';
import mammoth from 'mammoth';
import { INPUT_CONFIG } from '@/constants/inputConfig';

export type ParsedAnalysisInput = {
  meetingText: string;
  fileName: string;
};

export async function parseAnalysisInput(request: NextRequest): Promise<ParsedAnalysisInput> {
  const contentType = request.headers.get('content-type') || '';
  const config = INPUT_CONFIG.web;

  if (config.parseMode === 'file' && contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      throw new Error('缺少文件');
    }

    if (file.size > config.maxFileSize) {
      throw new Error('文件大小超过限制（最大10MB）');
    }

    const fileName = file.name || 'meeting-minutes';
    const normalizedFileName = fileName.toLowerCase();
    const isValidFormat = config.supportedFormats.some((format) =>
      normalizedFileName.endsWith(format)
    );

    if (!isValidFormat) {
      throw new Error(`不支持的文件格式，请上传 ${config.supportedFormats.join(' 或 ')} 文件`);
    }

    if (normalizedFileName.endsWith('.docx')) {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const result = await mammoth.extractRawText({ buffer });
      return { meetingText: result.value, fileName };
    }

    return { meetingText: await file.text(), fileName };
  }

  const body = await request.json();
  if (!body.data) {
    throw new Error('缺少数据');
  }

  return {
    meetingText: String(body.data),
    fileName: typeof body.fileName === 'string' ? body.fileName : 'meeting-minutes.txt',
  };
}
