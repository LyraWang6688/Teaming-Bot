import {
  AlertCircle,
  Activity,
  CheckCircle,
  Users,
  Target,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * 颜色分级配置 (健康/良好/警惕)
 */
export const LEVEL_CONFIG: Record<
  string,
  { label: string; style: string; iconColor: string; Icon: LucideIcon }
> = {
  Red: {
    label: '警惕',
    style: 'bg-red-100 text-red-800 border-red-200',
    iconColor: 'text-red-600',
    Icon: AlertCircle
  },
  Blue: {
    label: '良好',
    style: 'bg-blue-100 text-blue-800 border-blue-200',
    iconColor: 'text-blue-600',
    Icon: Activity
  },
  Green: {
    label: '健康',
    style: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    iconColor: 'text-emerald-600',
    Icon: CheckCircle
  },
  Grey: {
    label: '难以判断',
    style: 'bg-slate-100 text-slate-800 border-slate-200',
    iconColor: 'text-slate-400',
    Icon: AlertCircle
  },
};

/**
 * 动力象限配置
 */
export const ZONE_CONFIG: Record<string, { label: string; style: string; chartFill: string }> = {
  Apathy: {
    label: '冷漠区',
    style: 'bg-slate-100 text-slate-800',
    chartFill: '#f1f5f9'
  },
  Comfort: {
    label: '舒适区',
    style: 'bg-blue-100 text-blue-800',
    chartFill: '#dbeafe'
  },
  Anxiety: {
    label: '焦虑区',
    style: 'bg-red-100 text-red-800',
    chartFill: '#fee2e2'
  },
  Learning: {
    label: '学习区',
    style: 'bg-emerald-100 text-emerald-800',
    chartFill: '#dcfce7'
  },
};

/**
 * 四大组队行为标签与定义（基于 Amy Edmondson "Teaming" 原著）
 */
export const BEHAVIOR_LABELS: Record<string, string> = {
  speakingUp: '直言不讳',
  collaboration: '协同',
  experimentation: '实验',
  reflection: '反思',
};

/**
 * 四大组队行为的完整定义（基于 Amy Edmondson "Teaming" 原著）
 * 用于 LLM 提示词中的行为评估指导
 */
export const BEHAVIOR_DEFINITIONS: Record<string, { short: string; full: string }> = {
  speakingUp: {
    short: '坦诚直接的对话，包括提出问题、寻求反馈、讨论错误和担忧',
    full: '组队能否成功，取决于个体之间坦诚、直接的对话，包括提出问题、寻求反馈和讨论错误。这是一种人际行为，使共同的见解可以从开诚布公的对话中涌现和生长出来。尤其当人们面对难题或失败时，直言不讳是非常关键的——关于经验、洞察和疑问的对话，有助于理解新的实践以及如何执行它们。Edmondson 特别指出："直言不讳不如你想的那么普遍"——多数人自认为直率，实则有所保留。评估时不要只看有没有人说话，要捕捉微妙的坦诚信号：有人犹豫后还是分享了担忧、有人承认"我不太确定这个方案"、有人主动寻求帮助（不只是提问）、有人提及过去的错误、有人提出了"不太受欢迎"的观点。直言不讳不仅指发言频率，更关注发言的坦诚程度和内容质量。',
  },
  collaboration: {
    short: '以合作、相互尊重和共同目标为特征的工作方式，包括跨边界协同与知识整合',
    full: '协同是一种与同事一起的工作方式，其特点是合作、相互尊重和共同目标。它涉及分享信息，协调行动，讨论什么有效什么无效，并不断寻求输入和反馈。组队依赖于部门内或部门间的协同行为，或更大范围组织内或组织间的协同。如果没有协同，组队很容易破裂——制定计划所需的信息将变得不足，计划的执行也会受到糟糕协同的影响。良好的协同心态对于紧随协同行动之后的共同反思也至关重要，因为它使得人们可以进行充分的、深思熟虑的专业意见分享。Edmondson 强调协同不仅指团队内部配合，更是"整合知识"的主动心态——不仅需要既定组队单元内部的协同，同时也需要内外部的协同。评估时不要只看"有没有配合"，要捕捉微妙的协同信号：有人主动把信息同步给需要的人、有人问"你们那边进展如何"、有人调整自己的节奏来配合他人、有人邀请外部视角加入讨论、有人在别人卡住时主动补位。',
  },
  experimentation: {
    short: '试探性的、迭代的行动方式，承认每次互动的新颖性和不确定性',
    full: '组队涉及一种试探性的、迭代的行动方式，承认个体之间的每一次互动都有其天然的新颖性和不确定性。实验不等同于正式的"试点项目"或"创新方案"——它的核心是面对不确定性的态度：承认事物的不确定性，先试一步、看反馈再调整，而不是等到确定才行动。会议中的一句"要不我们先试试X？""先做一个小版本看看效果"，就是实验精神。评估实验不要只找正式的探索动作，也要捕捉对话中微妙的试探信号：有人承认"我们还不确定"、有人提议先试后调、有人在讨论中能看到迭代思维。',
  },
  reflection: {
    short: '对流程和产出进行外显的观察、提问与讨论，持续发生且体现工作节奏',
    full: '组队有赖于对流程和产出进行外显的观察、提问与讨论。这样的反思需要持续发生，且体现工作本身的节奏，无论是每天、每周或是依项目具体情况而定。反思并不一定意味着要通过大量的会议来深入分析团队的过程或表现；相反，它通常是迅速且务实的。反思更多是一种行为倾向而非正式流程——行动中的反思是对某个过程进行批判的、实时的检验，从而对其作出调整。会议中的一句"等等，这个方向对吗？""上次那样效果不好，这次我们换一种做法"，就是反思。评估反思不要只找正式的复盘环节，也要捕捉嵌在工作节奏里的微反思：有人停下来质疑当前方向、有人主动说"我觉得上次的方法有问题"、有人对结果提出批判性观察。',
  },
};

/**
 * 图表通用调色盘
 */
export const CHART_COLORS = [
  '#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f43f5e', '#14b8a6', '#f97316', '#6366f1',
];

/**
 * 互动方向性配置
 * 用于判断团队互动网络的拓扑结构
 */
export const INTERACTION_DIRECTION_CONFIG = {
  STAR: {
    label: '星形结构',
    description: '大部分互动指向Leader，横向互动薄弱',
    icon: Target,
    style: 'text-red-600 bg-red-50',
    threshold: 0.6  // 星形占比超过60%即为星形结构
  },
  MESH: {
    label: '网状结构',
    description: '成员之间有频繁的横向互动与支持',
    icon: Users,
    style: 'text-emerald-600 bg-emerald-50',
    threshold: 0.4  // 横向互动超过40%即为网状结构
  },
  MIXED: {
    label: '混合结构',
    description: '星形与网状结构并存',
    icon: Activity,
    style: 'text-blue-600 bg-blue-50'
  }
};

/**
 * 启动成本配置
 * 用于判断打破沉默的难度，反映心理安全感
 */
export const STARTUP_COST_CONFIG = {
  HIGH: {
    label: '高启动成本',
    description: '需要领导者高强度情绪表达才能打破沉默',
    score: 'Red',
    icon: Zap,
    style: 'text-red-600 bg-red-50',
    indicators: ['高强度情绪表达', '反复提问无人回应', '强制点名']
  },
  MEDIUM: {
    label: '中等启动成本',
    description: '需要一定引导才能启动讨论',
    score: 'Blue',
    icon: Activity,
    style: 'text-blue-600 bg-blue-50',
    indicators: ['需要多次询问', '短暂沉默后回应', '部分成员主动']
  },
  LOW: {
    label: '低启动成本',
    description: '讨论自然流动，无需外部推动',
    score: 'Green',
    icon: CheckCircle,
    style: 'text-emerald-600 bg-emerald-50',
    indicators: ['自然发言', '主动提问', '观点自由表达']
  }
};

/**
 * 语境矛盾检测配置
 * 用于识别"伪共识"等隐性矛盾
 */
export const CONTEXT_CONTRADICTION_CONFIG = {
  INDICATORS: [
    {
      type: 'capacity_conflict',
      label: '能力与任务矛盾',
      description: '成员表达资源/时间/能力不足，但仍被要求接受高难度任务',
      severity: 'high',
      example: '成员表示"我很忙"或"人手不够"，但团队仍决定同时推进多个项目'
    },
    {
      type: 'consensus_mismatch',
      label: '共识质量矛盾',
      description: '在困难语境下无反对意见',
      severity: 'high',
      example: '项目存在明显风险，但所有人一致同意'
    },
    {
      type: 'expression_suppression',
      label: '表达抑制矛盾',
      description: '表面和谐但隐藏真实想法',
      severity: 'medium',
      example: '快速达成一致，未进行深入讨论'
    }
  ],
  SEVERITY_LEVELS: {
    high: {
      label: '严重矛盾',
      style: 'bg-red-100 text-red-800',
      action: '必须深入挖掘，不能接受表面共识'
    },
    medium: {
      label: '中等矛盾',
      style: 'bg-yellow-100 text-yellow-800',
      action: '需要进一步验证和探索'
    },
    low: {
      label: '轻微矛盾',
      style: 'bg-blue-100 text-blue-800',
      action: '关注后续发展'
    }
  }
};

/**
 * 互动模式配置（精简版）
 * 用于快速判断互动方向性，识别星形 vs 网状结构
 */
export const INTERACTION_PATTERN = {
  STAR: {
    label: '星形结构',
    description: '大部分互动指向Leader，成员间横向支持薄弱',
    indicators: [
      '成员发言后，只有Leader回应',
      'Leader发起话题，成员被动回应',
      '成员之间不互相补充或支持',
      'Leader停顿后，讨论中断'
    ]
  },
  MESH: {
    label: '网状结构',
    description: '成员之间有横向互动与支持',
    indicators: [
      '成员互相补充或延伸观点',
      '成员主动回应其他成员的发言',
      '成员之间形成对话链',
      '无需Leader持续驱动'
    ]
  }
};
