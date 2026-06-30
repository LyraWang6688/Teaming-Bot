/**
 * 网页端分析 API
 * 接收文件上传或文本输入，返回 JSON 格式的分析结果
 */

import { NextRequest, NextResponse } from 'next/server';
import { analyzeMeetingText } from '@/services/analysisService';
import { formatResult } from '@/formatters';
import { parseAnalysisInput } from '@/lib/analysis/inputParser';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';

export async function POST(request: NextRequest) {
  try {
    // 1. 根据输入源配置解析输入
    const { meetingText } = await parseAnalysisInput(request);

    // 2. 执行分析（统一服务）
    const result = await analyzeMeetingText(meetingText);

    // 3. 格式化输出（JSON）
    const formatted = await formatResult(result, 'web');

    return NextResponse.json(formatted);

  } catch (error: unknown) {
    logRuntimeMonitor('error', 'analyze_api', 'analyze_failed', toRuntimeErrorContext(error));
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '分析失败' },
      { status: 500 }
    );
  }
}
