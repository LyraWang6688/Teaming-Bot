/**
 * 网页端分析 API
 * 接收文件上传或文本输入，返回 JSON 格式的分析结果
 */

import { NextRequest, NextResponse } from 'next/server';
import mammoth from 'mammoth';
import { analyzeMeetingText } from '@/services/analysisService';
import { formatResult } from '@/formatters';
import { INPUT_CONFIG } from '@/constants/inputConfig';

/**
 * 根据输入源配置解析输入
 */
async function parseInput(request: NextRequest): Promise<string> {
  const contentType = request.headers.get('content-type') || '';
  const config = INPUT_CONFIG.web;

  if (config.parseMode === 'file' && contentType.includes('multipart/form-data')) {
    // 文件上传模式
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      throw new Error('缺少文件');
    }

    // 检查文件大小
    if (file.size > config.maxFileSize) {
      throw new Error('文件大小超过限制（最大10MB）');
    }

    // 检查文件格式
    const fileName = file.name.toLowerCase();
    const isValidFormat = config.supportedFormats.some(fmt => fileName.endsWith(fmt));
    if (!isValidFormat) {
      throw new Error(`不支持的文件格式，请上传 ${config.supportedFormats.join(' 或 ')} 文件`);
    }

    // 解析文件
    if (fileName.endsWith('.docx')) {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } else {
      return await file.text();
    }
  } else {
    // 纯文本模式
    const body = await request.json();
    if (!body.data) {
      throw new Error('缺少数据');
    }
    return body.data;
  }
}

export async function POST(request: NextRequest) {
  try {
    // 1. 根据输入源配置解析输入
    const meetingText = await parseInput(request);

    // 2. 执行分析（统一服务）
    const result = await analyzeMeetingText(meetingText);

    // 3. 格式化输出（JSON）
    const formatted = await formatResult(result, 'web');

    return NextResponse.json(formatted);

  } catch (error: unknown) {
    console.error('Analyze Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '分析失败' },
      { status: 500 }
    );
  }
}
