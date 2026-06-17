/**
 * 格式化器注册表
 * 统一管理不同输出格式的格式化函数
 */

import { jsonFormatter } from './jsonFormatter';
import { markdownFormatter } from './markdownFormatter';
import type { InputSource } from '@/constants/inputConfig';
import { getOutputConfig } from '@/constants/outputConfig';
import type { AnalysisResult } from '@/types';
import type { OutputConfig } from '@/constants/outputConfig';

/**
 * 格式化器注册表
 */
const FORMATTERS: Record<string, (result: AnalysisResult, config: OutputConfig) => string | object> = {
  jsonFormatter,
  markdownFormatter,
};

/**
 * 根据输入源获取对应的格式化器并执行
 */
export async function formatResult(
  result: AnalysisResult,
  source: InputSource
): Promise<string | object> {
  const config = getOutputConfig(source);
  const formatter = FORMATTERS[config.formatterName];

  if (!formatter) {
    throw new Error(`Unknown formatter: ${config.formatterName}`);
  }

  return formatter(result, config);
}
