/**
 * 输出策略配置
 * 定义不同输入源对应的输出格式和功能
 */

import type { InputSource } from './inputConfig';

export type OutputFormat = 'json' | 'markdown';

export interface OutputConfig {
  format: OutputFormat;
  formatterName: string;
  includeMetadata: boolean;
  features: string[];
}

export const OUTPUT_CONFIG: Record<InputSource, OutputConfig> = {
  web: {
    format: 'json',
    formatterName: 'jsonFormatter',
    includeMetadata: true,
    features: ['visualization', 'pdf_export'],
  },
  feishu: {
    format: 'markdown',
    formatterName: 'markdownFormatter',
    includeMetadata: false,
    features: [],
  },
};

/**
 * 获取输出配置
 */
export function getOutputConfig(source: InputSource): OutputConfig {
  return OUTPUT_CONFIG[source];
}
