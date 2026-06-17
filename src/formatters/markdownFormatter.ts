/**
 * Markdown 格式化器
 * 用于飞书多维表格输出
 */

import type { AnalysisResult } from '@/types';
import type { OutputConfig } from '@/constants/outputConfig';

/**
 * Zone 中文映射
 */
const ZONE_LABELS: Record<string, string> = {
  Learning: '学习区',
  Comfort: '舒适区',
  Anxiety: '焦虑区',
  Apathy: '冷漠区',
  'Difficult to Judge': '难以判断',
};

/**
 * Level 中文映射
 */
const LEVEL_LABELS: Record<string, string> = {
  Green: '正常',
  Blue: '良好',
  Red: '警惕',
  Grey: '不适用',
};

/**
 * 行为维度中文映射
 */
const BEHAVIOR_LABELS: Record<string, string> = {
  speakingUp: '直言不讳',
  collaboration: '协同',
  experimentation: '实验',
  reflection: '反思',
};

/**
 * 将分析结果格式化为 Markdown 文本
 * 用于飞书多维表格存储
 */
export function markdownFormatter(result: AnalysisResult, _config: OutputConfig): string {
  const { teamState, behaviors, leaderAdvice } = result;

  const sections: string[] = [];

  // 1. 团队状态
  const zoneLabel = ZONE_LABELS[teamState.zone] || teamState.zone;
  sections.push(`【团队状态】${zoneLabel}`);
  sections.push('');

  // 2. 动力诊断
  sections.push(`【动力诊断】`);
  sections.push(teamState.analysis);
  sections.push('');

  // 3. 行为评估
  sections.push(`【行为评估】`);
  const behaviorOrder = ['speakingUp', 'collaboration', 'experimentation', 'reflection'] as const;
  for (const key of behaviorOrder) {
    const behavior = behaviors[key];
    if (behavior) {
      const label = BEHAVIOR_LABELS[key] || key;
      const levelLabel = LEVEL_LABELS[behavior.level] || behavior.level;
      sections.push(`- ${label}：${levelLabel} — ${behavior.summary}`);
    }
  }
  sections.push('');

  // 4. 给领导者的建议
  sections.push(`【给领导者的建议】`);
  sections.push(leaderAdvice.advice);

  return sections.join('\n');
}
