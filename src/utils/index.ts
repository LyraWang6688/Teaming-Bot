/**
 * 文本清洗工具：仅移除 AI 内部生成的 L2/L3 标签，保留发言者姓名
 */
export const cleanEvidence = (text: string) => {
  return text
    .replace(/^L[0-3]\s*[：:]?\s*/i, ''); // 仅移除 L0-L3 的等级标记
};

// 重新导出常量配置（保持向后兼容）
export {
  LEVEL_CONFIG,
  ZONE_CONFIG,
  BEHAVIOR_LABELS,
  CHART_COLORS
} from '@/constants';
