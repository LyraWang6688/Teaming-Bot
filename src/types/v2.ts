/**
 * V2 类型定义（当前活跃版本）。
 *
 * 对应 schemaVersion=2 的新报告数据结构，由 V2 渲染器（AnalysisDashboardV2）读取。
 * 新报告均生成此结构，由 projects3 项目的分析引擎产出。
 *
 * V2 特征：
 * - 证据一次提取 + 报告写作并行（engine.ts 编排）
 * - psychologicalSafety / accountability 两维方向（DimensionAssessmentV2）
 * - leaderAdvice 为数组
 * - DialogueNetwork 含 noteworthyPattern
 * - 含 crossBoundaryLearning / learningBehaviors
 * - Zone 由 decision.ts 推导（非决策树）
 */

export type TeamZoneV2 = 'Apathy' | 'Comfort' | 'Anxiety' | 'Learning' | 'Difficult to Judge';
export type BoundaryDimensionV2 = 'psychologicalSafety' | 'accountability' | 'none';
export type ParticipantTypeV2 = 'internal' | 'external' | 'facilitator' | 'unknown';

// 旧雷达图组件仍保留在项目中，但不再出现于前台报告。
export interface BehaviorMetricV2 {
  level: 'Red' | 'Blue' | 'Green' | 'Grey';
  score: number;
  evidence: string[];
  summary: string;
}

export interface TeamBehaviorsV2 {
  speakingUp: BehaviorMetricV2;
  collaboration: BehaviorMetricV2;
  experimentation: BehaviorMetricV2;
  reflection: BehaviorMetricV2;
}

export type EvidenceDirectionV2 = 'higher' | 'lower' | 'insufficient';
export type EvidenceConfidenceV2 = 'high' | 'medium' | 'low';

export interface DimensionAssessmentV2 {
  direction: EvidenceDirectionV2;
  confidence: EvidenceConfidenceV2;
  summary: string;
  evidence: string[];
  limitation?: string;
}

export interface LearningBehaviorObservationV2 {
  process: 'information_feedback' | 'joint_inquiry' | 'experiment_validation' | 'reflection_improvement';
  observation: string;
  evidence: string;
  relevance: 'central' | 'supporting';
}

export interface TeamStateV2 {
  zone: TeamZoneV2;
  /** 由代码根据 zone 和 adjacentZone 生成，不接受模型自由改写。 */
  zoneLabel: string;
  /** 只允许四象限中与主区域共边的区域。 */
  adjacentZone?: Exclude<TeamZoneV2, 'Difficult to Judge'>;
  /** 哪一个维度接近高低分界；none 表示没有足够依据判断接近边界。 */
  boundaryDimension?: BoundaryDimensionV2;
  /** 由 boundaryDimension 确定，用于四象限中的轻量化位置。 */
  positionHint: 'center' | 'near_horizontal_boundary' | 'near_vertical_boundary';
  psychologicalSafety: DimensionAssessmentV2;
  accountability: DimensionAssessmentV2;
  analysis: string;
  learningOpportunity: string;
  confidenceNote: string;
}

export interface LeaderAdviceV2 {
  action: 'frame_for_learning' | 'create_psychological_safety' | 'learn_from_failure' | 'cross_boundaries';
  advice: string;
  reasoning: string;
  timing?: string;
  signalToWatch?: string;
  optionalScript?: string;
}

export interface CommunicationParticipantV2 {
  name: string;
  speakingShare: number;
  effectiveSentences: number;
  // 兼容项目中已停用的旧气泡图组件；新版报告不展示这两个分数。
  inquiryScore: number;
  advocacyScore: number;
}

export type PlayerRoleV2 = 'mover' | 'follower' | 'opposer' | 'bystander' | 'silent';

export interface NetworkNodeV2 {
  name: string;
  role?: string;
  playerRole: PlayerRoleV2;
  participantType?: ParticipantTypeV2;
  playerReason: string;
  secondaryFunctions?: string[];
  evidence?: string[];
  speakingShare?: number;
}

export interface NetworkEdgeV2 {
  source: string;
  target: string;
  weight: 'strong' | 'moderate' | 'light';
  nature?: string;
  count?: number;
}

export interface DialogueNetworkV2 {
  nodes: NetworkNodeV2[];
  edges: NetworkEdgeV2[];
  analysis: string;
  noteworthyPattern: string;
}

export interface MeetingMetadataV2 {
  meetingType: string;
  meetingPurpose: string;
  contextSummary: string;
  crossBoundaryPresent: boolean;
  totalSentences: number;
  effectiveSentences: number;
  qualityFlag: 'normal' | 'low_sample' | 'unbalanced';
  durationLabel?: string;
  participantCount?: number;
  /** 会议转写头部记录的会议开始日期与时间。 */
  meetingStartedAt?: string;
  inputQualityNote?: string;
  /** full=完整模型分析；recovered=经过自动修复但核心分析完整；basic_fallback=模型未完成，仅保留基础事实。 */
  analysisMode?: 'full' | 'recovered' | 'basic_fallback';
  /** 面向用户的脱敏管线说明，不包含密钥、请求体或原始异常堆栈。 */
  pipelineNotice?: string;
}

export interface CrossBoundaryLearningV2 {
  summary: string;
  evidence?: string;
}

export interface UnfinishedDialogueV2 {
  topic: string;
  /** 对话已经讨论和确认到了哪里。 */
  conversationSoFar?: string;
  /** 尚缺少的答案、验证、决策或行动闭环，以及它对会议目标的影响。 */
  whatRemains?: string;
  /** 兼容旧报告。 */
  whyUnfinished?: string;
  /** 兼容旧报告。 */
  whyNeedsClosure?: string;
}

export interface UnseenDisagreementV2 {
  topic: string;
  /** 各方使用的不同假设、优先级、标准或风险取向。 */
  differentConcerns?: string;
  /** 不同观点试图共同保护的目标。 */
  sharedGoal?: string;
  whyItMatters: string;
  /** 兼容旧报告。 */
  whatEachSideSays?: string;
}

export interface AnalysisResultV2 {
  reportTimestamp: string;
  metadata: MeetingMetadataV2;
  summary: string;
  learningBehaviors: LearningBehaviorObservationV2[];
  teamState: TeamStateV2;
  crossBoundaryLearning?: CrossBoundaryLearningV2;
  unfinishedDialogues: UnfinishedDialogueV2[];
  unseenDisagreements: UnseenDisagreementV2[];
  leaderAdvice: LeaderAdviceV2[];
  communication: CommunicationParticipantV2[];
  dialogueNetwork: DialogueNetworkV2;
}

export interface BatchItemV2 {
  id: string;
  file: File;
  status: 'PENDING' | 'ANALYZING' | 'COMPLETE' | 'DEGRADED' | 'ERROR';
  result?: AnalysisResultV2;
  /** 从发起上传到取得完整报告的用时。 */
  generationSeconds?: number;
  error?: string;
  /** 流式分析的分析会话 ID（同一文件重试时复用）。 */
  analysisId?: string;
  /** 流式分析的当前累计用时（毫秒），用于前台显示。 */
  elapsedMs?: number;
}
