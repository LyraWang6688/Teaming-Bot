/**
 * Markdown 格式化器
 * 用于飞书多维表格输出
 */

import type { AnalysisResult } from '@/types';

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
export function markdownFormatter(result: AnalysisResult): string {
  const {
    teamState,
    behaviors,
    leaderAdvice,
    unfinishedDialogues,
    unseenDisagreements,
    dialogueNetwork,
    keyAssumptions,
  } = result;

  const sections: string[] = [];

  const zoneLabel = ZONE_LABELS[teamState.zone] || teamState.zone;
  sections.push('【第一部分：团队整体状态】');
  sections.push(`当前区域：${zoneLabel}`);
  sections.push('');
  sections.push(teamState.analysis);
  sections.push('');

  sections.push('【行为评估】');
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

  if (dialogueNetwork) {
    sections.push('【第二部分：团队互动网络】');
    sections.push(dialogueNetwork.analysis);
    if (dialogueNetwork.riskAssessment) {
      sections.push('');
      sections.push(`需要注意的是：${dialogueNetwork.riskAssessment}`);
    }
    sections.push('');
  }

  if (unfinishedDialogues.length > 0) {
    sections.push('【第三部分：未完形对话】');
    unfinishedDialogues.forEach((item, index) => {
      sections.push(`${index + 1}. ${item.topic}`);
      sections.push(`- 为什么没有完形：${item.whyUnfinished}`);
      sections.push(`- 为什么需要完形：${item.whyNeedsClosure}`);
    });
    sections.push('');
  }

  if (unseenDisagreements.length > 0) {
    sections.push('【值得被看见的非共识】');
    unseenDisagreements.forEach((item, index) => {
      sections.push(`${index + 1}. ${item.topic}`);
      sections.push(`- 各方看法：${item.whatEachSideSays}`);
      sections.push(`- 为什么重要：${item.whyItMatters}`);
    });
    sections.push('');
  }

  if (keyAssumptions.length > 0) {
    sections.push('【关键假设】');
    keyAssumptions.forEach((item, index) => {
      sections.push(`${index + 1}. ${item.assumption}`);
      sections.push(`- 为什么值得验证：${item.whyToVerify}`);
    });
    sections.push('');
  }

  sections.push('【第四部分：给领导者的建议】');
  sections.push(leaderAdvice.advice);
  if (leaderAdvice.reasoning) {
    sections.push('');
    sections.push(`为什么给出这个建议：${leaderAdvice.reasoning}`);
  }

  return sections.join('\n');
}
