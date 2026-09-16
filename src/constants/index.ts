/**
 * 统一导出所有常量和配置
 *
 * 文件结构说明：
 * - zoneConfig.ts: TeamZone 类型 re-export（V2 Zone 计算在 lib/analysis/decision.ts）
 * - behaviorConfig.ts: 行为维度定义与配置（BEHAVIOR_DIMENSIONS, LEVEL_CONFIG等）
 * - inputConfig.ts: 输入源配置（web、feishu等）
 * - outputConfig.ts: 输出策略配置（JSON、Markdown等）
 */

// 从 zoneConfig.ts 导出
export type { TeamZone } from './zoneConfig';

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
