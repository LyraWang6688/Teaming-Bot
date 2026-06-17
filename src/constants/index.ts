/**
 * 统一导出所有常量和配置
 *
 * 文件结构说明：
 * - teamingRules.ts: 系统提示词和业务规则
 * - zoneConfig.ts: Zone类型、计算、验证和期望配置
 * - behaviorConfig.ts: 行为维度定义与配置（BEHAVIOR_DIMENSIONS, LEVEL_CONFIG等）
 * - inputConfig.ts: 输入源配置（web、feishu等）
 * - outputConfig.ts: 输出策略配置（JSON、Markdown等）
 */

// 从 teamingRules.ts 导出
export { TEAMING_SYSTEM_INSTRUCTION } from './teamingRules';

// 从 zoneConfig.ts 导出
export type { TeamZone } from './zoneConfig';
export {
  ZONE_TONE,
  ZONE_BEHAVIOR_EXPECTATIONS,
  inferZoneFromScores,
  validateBehaviorLevel,
  determineZoneFromBehaviors,  // 决策树判定 Zone
  regenerateAnalysis  // Zone修正后重新生成analysis
} from './zoneConfig';

// 从 behaviorConfig.ts 导出
export {
  LEVEL_CONFIG,
  ZONE_CONFIG,
  BEHAVIOR_LABELS,
  BEHAVIOR_DEFINITIONS,
  CHART_COLORS
} from './behaviorConfig';

// 从 inputConfig.ts 导出
export type { InputSource, InputConfig } from './inputConfig';
export { INPUT_CONFIG, getInputConfig } from './inputConfig';

// 从 outputConfig.ts 导出
export type { OutputFormat, OutputConfig } from './outputConfig';
export { OUTPUT_CONFIG, getOutputConfig } from './outputConfig';
