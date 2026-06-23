/**
 * Zone配置相关常量和函数
 * 包含Zone类型定义、计算逻辑、验证逻辑
 */

import type { TeamBehaviors, BehaviorMetric } from '@/types';

/**
 * Zone类型定义
 */
export type TeamZone = 'Apathy' | 'Comfort' | 'Anxiety' | 'Learning' | 'Difficult to Judge';

/**
 * Zone级别的色调定义（用于视觉一致性）
 */
export const ZONE_TONE: Record<TeamZone, { primary: string; expectation: string }> = {
  Apathy: {
    primary: 'Red',
    expectation: '团队处于低活跃度状态，互动薄弱、产出质量低'
  },
  Comfort: {
    primary: 'Blue',
    expectation: '团队氛围良好但停留在事务层面，需要突破舒适区'
  },
  Anxiety: {
    primary: 'Red',
    expectation: '团队追求结果但氛围紧张，需要提升心理安全感'
  },
  Learning: {
    primary: 'Green',
    expectation: '团队处于最佳状态，持续学习和成长'
  },
  'Difficult to Judge': {
    primary: 'Grey',
    expectation: '信息不足，难以准确评估团队状态'
  }
};

/**
 * 行为级别到维度等级的映射
 * Green → H（高），Blue → M（中），Red → L（低）
 */
type Dimension = 'H' | 'M' | 'L';

/**
 * 将行为色标映射为维度等级
 *
 * @param level 行为色标（Green/Blue/Red/Grey）
 * @returns 维度等级 H/M/L
 */
function toDimension(level: string): Dimension {
  if (level === 'Green') return 'H';
  if (level === 'Blue') return 'M';
  if (level === 'Red') return 'L';
  if (level === 'Grey') {
    // 启动期的实验/反思维度标记为 Grey 是正常的，但视为 L（而非 M）
    // 理由：Grey 表示缺乏证据，启动期也不例外。将 Grey 视为 M 可能导致
    // 在 E/R 均为 Grey 时推导出 WS=高/中，进而错误进入学习区。
    // 真正的 H/M 级行为应该有实际证据（Green/Blue），而非缺乏证据的 Grey。
    return 'L';
  }
  return 'L';
}

/**
 * 决策树 Zone 判定
 *
 * 核心原则：
 * - 直言不讳(S)是第一分叉：敢不敢说，决定了心理安全感的底色
 * - 实验(E)和反思(R)是第二分叉：敢不敢试+愿不愿想，决定了工作标准的底色
 * - 协同(C)不参与分叉，但影响报告文字的质地描述
 *
 * 决策树：
 * S=H/M（直言不讳≥中等）?
 * ├─ 是 → E≥M 且 R≥M（实验+反思都≥中等）?
 * │       ├─ 是 → 学习区（24种排列）
 * │       └─ 否 → 舒适区（30种排列）
 * └─ 否 → E≥M 或 R≥M（实验或反思至少一个≥中等）?
 *         ├─ 是 → 焦虑区（24种排列）
 *         └─ 否 → 冷漠区（3种排列）
 *
 * 排列数验证：24+30+24+3=81 ✓
 *
 * 为什么不用 PS×WS 推导法：
 * PS 不只与 S/C 有关，WS 不只与 E/R 有关。PS×WS 是中间抽象，
 * 强行从行为推导 PS/WS 再映射 Zone 会丢失信息（如 S=H,E=H,R=L
 * 被推导为 PS高+WS中=学习区，但 E=H/R=L 意味着学习闭环断裂）。
 * 决策树直接从行为色标到 Zone，不经过中间抽象层。
 */
export function determineZoneFromBehaviors(
  behaviors: TeamBehaviors | null | undefined,
  qualityFlag?: string
): TeamZone {
  if (!behaviors) return 'Difficult to Judge';

  const {
    speakingUp,
    collaboration,
    experimentation,
    reflection
  } = behaviors;

  const getLevel = (behavior?: BehaviorMetric): string => behavior?.level || 'Grey';

  const sLevel = getLevel(speakingUp);
  const cLevel = getLevel(collaboration);
  const eLevel = getLevel(experimentation);
  const rLevel = getLevel(reflection);

  // 硬性阈值：如果 ≥50% 行为维度为 Grey，无法可靠判断
  const allLevels = [sLevel, cLevel, eLevel, rLevel];
  const greyCount = allLevels.filter(l => l === 'Grey').length;
  if (greyCount >= 2) return 'Difficult to Judge';

  // 如果核心维度（直言不讳）和次要维度（协同）都是 Grey，无法判断
  if (sLevel === 'Grey' && cLevel === 'Grey') return 'Difficult to Judge';

  // 将行为色标映射为维度等级
  const s = toDimension(sLevel);
  const e = toDimension(eLevel);
  const r = toDimension(rLevel);

  // 决策树判定 Zone
  let zone: TeamZone;

  if (s === 'H' || s === 'M') {
    // 直言不讳≥中等：安全感底色尚可
    if ((e === 'H' || e === 'M') && (r === 'H' || r === 'M')) {
      // 实验+反思都≥中等：学习闭环完整
      zone = 'Learning';
    } else {
      // 实验/反思有短板：安全但不挑战
      zone = 'Comfort';
    }
  } else {
    // 直言不讳=低：安全感缺失
    if ((e === 'H' || e === 'M') || (r === 'H' || r === 'M')) {
      // 实验/反思至少一个≥中等：有标准但不敢说
      zone = 'Anxiety';
    } else {
      // 实验+反思都低：既不安全也没标准
      zone = 'Apathy';
    }
  }

  // low_sample 时跳过学习区判定
  // 数据不足时不能下"学习区"的结论，降级为舒适区
  if (qualityFlag === 'low_sample' && zone === 'Learning') {
    return 'Comfort';
  }

  return zone;
}

/**
 * Zone与行为的期望级别映射
 * 定义每个zone下，各个行为最典型的级别范围
 *
 * 基于决策树 Zone 判定逻辑：
 * - 直言不讳(S)是第一分叉，实验(E)和反思(R)是第二分叉
 * - 协同(C)不参与分叉，但影响报告文字质地
 *
 * 注意：此映射描述的是"典型"模式，而非数学上的完备空间。
 * 实际 Zone 判定由 determineZoneFromBehaviors 的决策树逻辑完成。
 */
export const ZONE_BEHAVIOR_EXPECTATIONS: Record<
  TeamZone,
  { speakingUp: string[]; collaboration: string[]; experimentation: string[]; reflection: string[] }
> = {
  // 冷漠区：低心理安全感 + 低工作标准
  // 典型：用最小努力完成工作，不在乎所以不说、不配合、不试、不反思
  // 积极回避证据：观望态度、敷衍响应、最小努力、精力用于争权夺利而非共同目标
  Apathy: {
    speakingUp: ['Red', 'Grey'],
    collaboration: ['Red', 'Grey'],
    experimentation: ['Red', 'Grey'],
    reflection: ['Red', 'Grey']
  },
  // 舒适区：高心理安全感 + 低工作标准
  // 典型：真的敢说、真的能配合，但没理由寻求额外挑战——不承认不确定性、不批判性检视
  Comfort: {
    speakingUp: ['Green', 'Blue'],
    collaboration: ['Green', 'Blue'],
    experimentation: ['Red'],  // 舒适区核心特征：面对不确定性时固守已知、不试探迭代
    reflection: ['Red']        // 舒适区核心特征：对行动结果只接受不检视
  },
  // 焦虑区：低心理安全感 + 高（或中）工作标准
  // 典型：不敢提出想法、不敢尝试新的程序、不敢寻求帮助（Edmondson 原文）
  // 协同可能是被动配合（Blue/Red），实验可能是被迫（Red/Blue），反思可能是交差式（Blue/Red）
  Anxiety: {
    speakingUp: ['Red'],                // 核心特征：不敢说
    collaboration: ['Blue', 'Red'],     // 被动配合或不配合
    experimentation: ['Red', 'Blue'],   // 不敢试新的或被迫尝试
    reflection: ['Red', 'Blue']         // 不敢深挖或交差式复盘
  },
  // 学习区：高心理安全感 + 高工作标准
  // 典型：坦诚沟通、协同心态、面对不确定性试探迭代、批判性检视——全部到位
  Learning: {
    speakingUp: ['Green', 'Blue'],
    collaboration: ['Green', 'Blue'],
    experimentation: ['Green', 'Blue'],
    reflection: ['Green', 'Blue']
  },
  // 难以判断：不强制要求
  'Difficult to Judge': {
    speakingUp: ['Red', 'Blue', 'Green', 'Grey'],
    collaboration: ['Red', 'Blue', 'Green', 'Grey'],
    experimentation: ['Red', 'Blue', 'Green', 'Grey'],
    reflection: ['Red', 'Blue', 'Green', 'Grey']
  }
};

/**
 * 行为级别到自然语言描述的映射
 */
/**
 * 当后端修正 Zone 后，根据最终 Zone 和行为数据重新生成 analysis
 * 确保文字总结与最终 Zone 一致，不增加 LLM 调用
 * 生成风格为自然段落，避免格式化罗列
 *
 * PS/WS 分数的作用：
 * - 不参与 Zone 判定（Zone 由决策树决定）
 * - 作为 analysis 文字的量化参考，帮助读者对照"行为判断"与"分数指向"
 *
 * @param finalZone 后端确定的最终 Zone
 * @param originalZone LLM 原始返回的 Zone
 * @param behaviors 行为分析数据
 * @param psScore 心理安全感分数（用于 analysis 文字参考）
 * @param wsScore 工作标准分数（用于 analysis 文字参考）
 * @returns 重新生成的 analysis 字符串
 */
export function regenerateAnalysis(
  finalZone: TeamZone,
  _originalZone: string,
  behaviors: TeamBehaviors | null | undefined,
  psScore: number,
  wsScore: number
): string {
  const getLevel = (b?: BehaviorMetric): string => b?.level || 'Grey';
  const getSummary = (b?: BehaviorMetric): string => b?.summary || '';
  const suLevel = getLevel(behaviors?.speakingUp);
  const coLevel = getLevel(behaviors?.collaboration);
  const exLevel = getLevel(behaviors?.experimentation);
  const reLevel = getLevel(behaviors?.reflection);
  const suSummary = getSummary(behaviors?.speakingUp);
  const coSummary = getSummary(behaviors?.collaboration);
  const exSummary = getSummary(behaviors?.experimentation);
  const reSummary = getSummary(behaviors?.reflection);

  // 自然地嵌入行为描述
  const embedSummary = (summary: string, fallback: string): string => {
    if (!summary) return fallback;
    return summary.endsWith('。') || summary.endsWith('，') || summary.endsWith('、')
      ? summary.replace(/[。，、]$/, '')
      : summary;
  };

  const isHigh = (level: string) => level === 'Green' || level === 'Blue';
  const isLow = (level: string) => level === 'Red';

  if (finalZone === 'Apathy') {
    // 冷漠区：从"低活跃"的整体印象切入，而非分数罗列
    const parts: string[] = [];
    if (isLow(suLevel)) parts.push(suSummary ? embedSummary(suSummary, '没有人提出疑问') : '没有人提出疑问');
    if (isLow(coLevel)) parts.push(coSummary ? embedSummary(coSummary, '各自为战') : '各自为战');
    if (isLow(exLevel)) parts.push(exSummary ? embedSummary(exSummary, '回避任何不确定性') : '回避任何不确定性');
    if (isLow(reLevel)) parts.push(reSummary ? embedSummary(reSummary, '从不回头看') : '直接推进不检视');
    const behaviorRef = parts.length > 0 ? `${parts.join('，')}——这些都是低活跃团队的典型表现。` : '';
    const scoreRef = psScore > 0 || wsScore > 0 ? `心理安全感${psScore > 0 && psScore <= 4 ? '偏低' : psScore > 4 && psScore <= 7 ? '一般' : '较高'}、工作标准${wsScore > 0 && wsScore <= 4 ? '偏低' : wsScore > 4 && wsScore <= 7 ? '一般' : '不低'}，` : '';
    return `这支团队像是处于节能模式${parts.length > 0 ? '：' : '。'}${behaviorRef}${scoreRef}整体来看，成员以最小努力完成工作，精力更多用于自我保护而非推进共同目标。团队需要先建立基本的信任基础和工作规范。`;
  }

  if (finalZone === 'Comfort') {
    // 舒适区：从"表面和谐"的矛盾切入
    const highParts: string[] = [];
    const lowParts: string[] = [];
    if (isHigh(suLevel)) highParts.push(suSummary ? embedSummary(suSummary, '大家愿意交流') : '大家愿意交流');
    if (isHigh(coLevel)) highParts.push(coSummary ? embedSummary(coSummary, '协作顺畅') : '协作顺畅');
    if (isLow(exLevel)) lowParts.push(exSummary ? embedSummary(exSummary, '回避不确定') : '面对不确定性固守已知');
    if (isLow(reLevel)) lowParts.push(reSummary ? embedSummary(reSummary, '浮于表面') : '讨论结束后直接推进');
    const highRef = highParts.length > 0 ? `表面上${highParts.join('，')}` : '';
    const lowRef = lowParts.length > 0 ? `，但${lowParts.join('，')}` : '';
    const scoreRef = psScore > 0 && psScore <= 7 ? `心理安全感${psScore <= 4 ? '尚可' : '不低'}` : '';
    const wsRef = wsScore > 0 && wsScore <= 4 ? `工作标准偏低` : wsScore > 0 ? `工作标准一般` : '';
    const scoreCombine = scoreRef && wsRef ? `${scoreRef}，${wsRef}——` : scoreRef ? `${scoreRef}，但停留在事务层面——` : wsRef ? `${wsRef}，挑战偏低——` : '';
    return `${highRef}${lowRef}。${scoreCombine}大家和和气气，却没有真正推动改变，这正是舒适区的典型特征。团队需要引入更有挑战性的目标，并养成检视和试探的习惯。`;
  }

  if (finalZone === 'Anxiety') {
    // 焦虑区：从"紧张感"切入，而非"PS几分WS几分"
    const parts: string[] = [];
    if (isLow(suLevel)) parts.push(suSummary ? embedSummary(suSummary, '没有人敢提出想法') : '没有人敢提出想法');
    if (isLow(coLevel)) parts.push(coSummary ? embedSummary(coSummary, '各自为政') : '配合更像是被动响应');
    else parts.push(coSummary ? embedSummary(coSummary, '协同更像是被动响应') : '协同更多是被动响应而非发自内心');
    if (isLow(exLevel)) parts.push(exSummary ? embedSummary(exSummary, '回避不确定性') : '不敢尝试新的程序');
    else if (isHigh(exLevel)) parts.push(exSummary ? embedSummary(exSummary, '试探多为外部施压') : '试探行为多为外部施压而非主动迭代');
    if (isLow(reLevel)) parts.push(reSummary ? embedSummary(reSummary, '不敢深挖问题') : '不敢深挖问题');
    else if (isHigh(reLevel)) parts.push(reSummary ? embedSummary(reSummary, '复盘浮于表面') : '检视多为交差式复盘');
    const behaviorRef = parts.length > 0 ? `${parts.join('，')}。` : '';
    const psRef = psScore > 0 && psScore <= 4 ? '心理安全感偏低' : '心理安全感不足';
    const wsRef = wsScore > 0 && wsScore >= 5 ? '工作标准却不低' : '工作标准却未同步下降';
    return `这支团队弥漫着一种紧张感——${psRef}，${wsRef}，标准与安全感形成了鲜明的落差。${behaviorRef}管理者可能将高标准等同于好的管理，但高标准加低安全感的搭配，往往导致次优绩效。团队需要先建立心理安全感，才能让工作标准真正发挥正向作用。`;
  }

  if (finalZone === 'Learning') {
    // 学习区：从"良性循环"的整体印象切入
    const parts: string[] = [];
    if (isHigh(suLevel)) parts.push(suSummary ? embedSummary(suSummary, '坦诚交流') : '成员间坦诚交流');
    if (isHigh(coLevel)) parts.push(coSummary ? embedSummary(coSummary, '协作深入') : '主动协同配合');
    if (isHigh(exLevel)) parts.push(exSummary ? embedSummary(exSummary, '勇于探索') : '在不确定性中敢于试探');
    if (isHigh(reLevel)) parts.push(reSummary ? embedSummary(reSummary, '持续改进') : '有批判性检视的习惯');
    const behaviorRef = parts.length > 0 ? `${parts.join('，')}——` : '';
    const psRef = psScore > 0 && psScore >= 5 ? '心理安全感处于较高水平' : '心理安全感处于较高水平';
    const wsRef = wsScore > 0 && wsScore >= 5 ? '工作标准也处于较高水平' : '工作标准也处于较高水平';
    return `${behaviorRef}${psRef}，${wsRef}，这支团队形成了一个良性循环：既能在安全的氛围中坦诚交流，又在工作标准上不断挑战自己。这种开放且有深度的互动模式值得持续保持。`;
  }

  // Difficult to Judge
  return `基于现有信息，难以对团队状态做出明确判断。会议内容可能过于简短或信息不充分，建议收集更多互动数据后再进行分析。`;
}

/**
 * 根据分数推断 Zone 的参考方向（仅用于 analysis 解读视角，不参与 Zone 判定）
 *
 * Zone 判定由决策树决定，分数是 analysis 的解读视角（PS/WS 为透镜，行为为佐证）。
 * 此函数帮助在 analysis 中描述"分数指向的 Zone"与"行为判定的 Zone"是否一致。
 *
 * @param psychologicalSafetyScore 心理安全感分数 (0-10)
 * @param workStandardScore 工作标准分数 (0-10)
 * @returns 分数推断的 Zone（仅供参考，不作为最终 Zone）
 */
export function inferZoneFromScores(
  psychologicalSafetyScore: number,
  workStandardScore: number
): TeamZone {
  if (
    psychologicalSafetyScore < 0 ||
    psychologicalSafetyScore > 10 ||
    workStandardScore < 0 ||
    workStandardScore > 10
  ) {
    return 'Difficult to Judge';
  }

  const highPsychSafety = psychologicalSafetyScore > 6;
  const highWorkStandard = workStandardScore > 6;

  if (highPsychSafety && highWorkStandard) {
    return 'Learning';
  } else if (highPsychSafety && !highWorkStandard) {
    return 'Comfort';
  } else if (!highPsychSafety && highWorkStandard) {
    return 'Anxiety';
  } else {
    return 'Apathy';
  }
}

/**
 * 验证行为级别是否符合zone的期望
 *
 * @param zone 团队zone
 * @param behaviorKey 行为key (speakingUp, collaboration, etc.)
 * @param behaviorLevel LLM返回的行为级别
 * @returns 是否一致，如果不一致返回期望的级别范围
 */
export function validateBehaviorLevel(
  zone: TeamZone,
  behaviorKey: keyof typeof ZONE_BEHAVIOR_EXPECTATIONS[TeamZone],
  behaviorLevel: string
): { 
  isValid: boolean; 
  expectedLevels: string[]; 
  currentLevel: string;
} {
  const expectedLevels = ZONE_BEHAVIOR_EXPECTATIONS[zone]?.[behaviorKey] || [
    'Red',
    'Blue',
    'Green',
    'Grey'
  ];

  const isValid = expectedLevels.includes(behaviorLevel);

  return {
    isValid,
    expectedLevels,
    currentLevel: behaviorLevel
  };
}



/**
 * Zone与互动方向性的期望映射
 * 定义每个zone下，期望的互动网络结构
 */
export const ZONE_INTERACTION_DIRECTION_EXPECTATIONS: Record<
  TeamZone,
  {
    structure: 'STAR' | 'MESH' | 'MIXED';
    description: string;
    keyIndicators: string[];
  }
> = {
  // 冷漠区：星形结构，完全依赖Leader驱动
  Apathy: {
    structure: 'STAR',
    description: '互动高度集中指向领导者，横向互动薄弱',
    keyIndicators: [
      'Leader发言占比 > 40%',
      '横向互动 < 20%',
      '成员主要被动回应Leader'
    ]
  },
  // 舒适区：混合结构，但偏向星形
  Comfort: {
    structure: 'MIXED',
    description: '有横向互动但深度有限，仍较多依赖流程引导',
    keyIndicators: [
      'Leader发言占比 30-50%',
      '横向互动 20-40%',
      '互动停留在事务层面'
    ]
  },
  // 焦虑区：星形结构，高强度压力下的单向驱动
  Anxiety: {
    structure: 'STAR',
    description: '高压力下互动高度依赖Leader推动，横向支持薄弱',
    keyIndicators: [
      'Leader发言占比 > 40% 且 使用强情绪',
      '横向互动 < 30%',
      '存在"伪共识"现象'
    ]
  },
  // 学习区：网状结构，成员间频繁横向互动
  Learning: {
    structure: 'MESH',
    description: '成员间有频繁的横向互动、支持和构建',
    keyIndicators: [
      'Leader发言占比 < 40%',
      '横向互动 > 40%',
      '成员主动互相补充和挑战'
    ]
  },
  // 难以判断：不强制要求
  'Difficult to Judge': {
    structure: 'MIXED',
    description: '信息不足，无法确定互动网络结构',
    keyIndicators: []
  }
};

/**
 * Zone与启动成本的期望映射
 * 定义每个zone下，打破沉默的难度期望
 */
export const ZONE_STARTUP_COST_EXPECTATIONS: Record<
  TeamZone,
  {
    level: 'HIGH' | 'MEDIUM' | 'LOW';
    description: string;
    indicators: string[];
  }
> = {
  // 冷漠区：高启动成本
  Apathy: {
    level: 'HIGH',
    description: '需要反复强制才能获得回应',
    indicators: [
      '反复提问无人回应',
      '强制点名才能发言',
      '短暂沉默后仍无主动发言'
    ]
  },
  // 舒适区：中等启动成本
  Comfort: {
    level: 'MEDIUM',
    description: '需要引导才能启动，但一旦开始能自然流动',
    indicators: [
      '需要主持人引导发言',
      '短暂停顿后有人接话',
      '讨论集中在事务层面'
    ]
  },
  // 焦虑区：高启动成本
  Anxiety: {
    level: 'HIGH',
    description: '需要领导者高强度情绪表达才能打破沉默',
    indicators: [
      'Leader使用强烈情绪打破沉默',
      '成员压力表达明显',
      '讨论依赖Leader单向驱动'
    ]
  },
  // 学习区：低启动成本
  Learning: {
    level: 'LOW',
    description: '讨论自然流动，无需外部推动',
    indicators: [
      '成员自然主动发言',
      '观点自由表达',
      '无需反复引导'
    ]
  },
  // 难以判断：不强制要求
  'Difficult to Judge': {
    level: 'MEDIUM',
    description: '信息不足，无法判断启动成本',
    indicators: []
  }
};

/**
 * 伪共识检测配置
 * 特别针对焦虑区的诊断
 */
export const PSEUDO_CONSENSUS_DETECTION = {
  // 定义伪共识的核心特征
  DEFINITION: '在困难语境下，团队成员表面达成一致，但实际存在能力、资源或时间上的矛盾',

  // 伪共识的检测指标
  INDICATORS: [
    {
      type: 'capacity_mismatch',
      label: '能力与任务不匹配',
      weight: 3,
      description: '成员表达资源/时间/能力不足，但仍接受高难度任务',
      example: '"我很忙，现在时间不够" → "好的，那我们同时推进两个项目"'
    },
    {
      type: 'no_opposition_under_difficulty',
      label: '困难语境下无反对意见',
      weight: 3,
      description: '项目存在明显风险或困难，但所有人一致同意',
      example: '项目时间紧迫、技术难度高，但无人提出质疑或反对'
    },
    {
      type: 'quick_agreement',
      label: '快速达成一致（未深入讨论）',
      weight: 1,
      description: '在重大决策上快速达成一致，跳过深入探讨',
      example: '决定推进两个高难度需求，但未讨论可行性或风险'
    },
    {
      type: 'leader_driven_consensus',
      label: '领导者主导的共识',
      weight: 2,
      description: '共识主要由领导者推动，成员被动接受',
      example: 'Leader提出建议后，成员快速附和，无独立思考'
    }
  ],

  // 伪共识强度的判断规则
  JUDGE_RULES: {
    HIGH_PSEUDO: {
      threshold: 6,  // 权重总分 ≥ 6
      label: '高度伪共识',
      style: 'text-red-600 bg-red-50',
      implication: '团队处于高风险状态，执行极易变形'
    },
    MEDIUM_PSEUDO: {
      threshold: 3,  // 权重总分 ≥ 3 且 < 6
      label: '中度伪共识',
      style: 'text-yellow-600 bg-yellow-50',
      implication: '存在潜在风险，需要关注后续执行'
    },
    LOW_PSEUDO: {
      threshold: 0,  // 权重总分 ≥ 0 且 < 3
      label: '无明显伪共识',
      style: 'text-emerald-600 bg-emerald-50',
      implication: '共识质量较好'
    }
  },

  // 伪共识与Zone的关联规则
  ZONE_IMPLICATIONS: {
    Anxiety: {
      description: '焦虑区最容易出现伪共识，高目标 + 低心理安全感',
      critical: true,
      action: '必须检测伪共识，如果存在则强化焦虑区判断'
    },
    Comfort: {
      description: '舒适区可能出现伪共识，但风险较低',
      critical: false,
      action: '如果存在伪共识，倾向于判断为焦虑区而非舒适区'
    },
    Apathy: {
      description: '冷漠区可能存在表面共识',
      critical: false,
      action: '伪共识不是冷漠区的核心特征'
    },
    Learning: {
      description: '学习区不应出现伪共识',
      critical: true,
      action: '如果检测到伪共识，严禁判断为学习区'
    }
  }
};

/**
 * 张力矩阵配置
 * 分析目标难度与信任基础之间的张力
 */
export const TENSION_MATRIX_CONFIG = {
  // 张力等级定义
  LEVELS: {
    HIGH: {
      label: '高张力',
      style: 'text-red-600 bg-red-50',
      score: 'Red',
      description: '目标难度远高于信任基础，风险极高',
      condition: (goalDifficulty: number, trustFoundation: number) => goalDifficulty - trustFoundation >= 3
    },
    MEDIUM: {
      label: '中等张力',
      style: 'text-yellow-600 bg-yellow-50',
      score: 'Yellow',
      description: '目标难度略高于信任基础，存在一定风险',
      condition: (goalDifficulty: number, trustFoundation: number) =>
        goalDifficulty - trustFoundation >= 1 && goalDifficulty - trustFoundation < 3
    },
    LOW: {
      label: '低张力',
      style: 'text-emerald-600 bg-emerald-50',
      score: 'Green',
      description: '目标难度与信任基础匹配，风险可控',
      condition: (goalDifficulty: number, trustFoundation: number) => goalDifficulty - trustFoundation < 1
    }
  },

  // 张力等级与Zone的关联
  ZONE_CORRELATION: {
    Anxiety: {
      expectedTension: 'HIGH',
      description: '焦虑区应呈现高张力状态',
      deviationImpact: '高'
    },
    Comfort: {
      expectedTension: 'LOW',
      description: '舒适区应呈现低张力状态',
      deviationImpact: '中等'
    },
    Apathy: {
      expectedTension: 'MEDIUM',
      description: '冷漠区可能呈现中等张力',
      deviationImpact: '低'
    },
    Learning: {
      expectedTension: 'LOW',
      description: '学习区应呈现低张力状态（目标与信任匹配）',
      deviationImpact: '高'
    }
  },

  // 张力导致的潜在后果
  POTENTIAL_CONSEQUENCES: {
    HIGH: [
      '执行变形（为完成任务而牺牲质量）',
      '核心成员倦怠或离职',
      '伪共识积累导致后期爆发',
      '团队士气崩塌',
      '项目失败风险大幅增加'
    ],
    MEDIUM: [
      '效率下降',
      '士气波动',
      '潜在矛盾积累',
      '协作摩擦增加'
    ],
    LOW: [
      '无明显风险',
      '可持续协作',
      '团队稳定性好'
    ]
  }
};
