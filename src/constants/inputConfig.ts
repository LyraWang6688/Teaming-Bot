/**
 * 输入源配置
 * 定义不同输入来源的解析规则和处理方式
 */

export type InputSource = 'web' | 'feishu';

export interface InputConfig {
  name: string;
  parseMode: 'file' | 'text';
  supportedFormats: string[];
  maxFileSize: number;
  requireAuthentication: boolean;
}

export const INPUT_CONFIG: Record<InputSource, InputConfig> = {
  web: {
    name: '网页端上传',
    parseMode: 'file',
    supportedFormats: ['.txt', '.docx'],
    maxFileSize: 10 * 1024 * 1024, // 10MB
    requireAuthentication: false,
  },
  feishu: {
    name: '飞书多维表格',
    parseMode: 'text',
    supportedFormats: ['text'],
    maxFileSize: 10 * 1024 * 1024,
    requireAuthentication: false,
  },
};

/**
 * 获取输入配置
 */
export function getInputConfig(source: InputSource): InputConfig {
  return INPUT_CONFIG[source];
}
