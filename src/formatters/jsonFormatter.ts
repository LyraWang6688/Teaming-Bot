/**
 * JSON 格式化器
 * 用于网页端输出
 */

import type { AnalysisResult } from '@/types';

/**
 * 将分析结果格式化为 JSON 对象
 * 网页端直接返回完整的分析结果
 */
export function jsonFormatter(result: AnalysisResult): object {
  // 网页端直接返回完整 JSON
  return result;
}
