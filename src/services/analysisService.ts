/**
 * 核心分析服务
 *
 * 与输入源无关的统一处理逻辑。签名 `analyzeMeetingText(transcript)` 保持不变，
 * 内部委托 V2 引擎 `analyzeTranscript` 完成证据提取 + 报告写作的完整流程。
 *
 * 返回类型从 V1 AnalysisResult 切到 V2 AnalysisResult（由 types/index.ts 默认导出）。
 */

import { analyzeTranscript } from '@/lib/analysis/engine';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import type { AnalysisResult } from '@/types';

export async function analyzeMeetingText(meetingText: string): Promise<AnalysisResult> {
  const startedAt = Date.now();
  try {
    const result = await analyzeTranscript(meetingText);
    const elapsedMs = Date.now() - startedAt;
    logRuntimeMonitor('info', 'analysis_service', 'analysis_completed', {
      elapsedMs,
      analysisMode: result.metadata.analysisMode,
      zone: result.teamState?.zone ?? null,
      meetingStartedAt: result.metadata.meetingStartedAt ?? null,
    });
    return result;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logRuntimeMonitor('error', 'analysis_service', 'analysis_failed', {
      elapsedMs,
      ...toRuntimeErrorContext(error),
    });
    throw error;
  }
}
