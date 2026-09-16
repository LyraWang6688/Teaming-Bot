/**
 * V1 类型定义（已冻结）。
 *
 * 对应 schemaVersion=1 的旧报告数据结构，由 V1 渲染器（AnalysisDashboardV1）读取。
 * 新报告不再生成此结构，但旧报告的 JSONB 仍是 V1 结构，需保留类型以正确读取旧数据。
 *
 * V1 特征：
 * - 四色标行为评估（behaviors: TeamBehaviorsV1）
 * - 决策树 Zone 判定（TeamStateV1 含 PS/WS/IF 三分数）
 * - leaderAdvice 为单条对象（非数组）
 * - DialogueNetwork 含 riskAssessment
 * - 含 KeyAssumption 类型
 */

export type TeamZoneV1 = 'Apathy' | 'Comfort' | 'Anxiety' | 'Learning' | 'Difficult to Judge';

export interface BehaviorMetricV1 {
  level: 'Red' | 'Blue' | 'Green' | 'Grey';
  score: number;
  evidence: string[];
  summary: string;
}

export interface TeamBehaviorsV1 {
  speakingUp: BehaviorMetricV1;
  collaboration: BehaviorMetricV1;
  experimentation: BehaviorMetricV1;
  reflection: BehaviorMetricV1;
}

export interface TeamStateV1 {
  zone: TeamZoneV1;
  psychologicalSafetyScore: number;
  workStandardScore: number;
  interactionFluidityScore: number;
  interactionFlowBreakdown: {
    networkStructureScore: number;
    dialogueDepthScore: number;
    crossTierInteractionScore: number;
  };
  psychologicalSafetyBreakdown: {
    speakingUpBehavior: number;
    positiveInteraction: number;
    errorTolerance: number;
  };
  workStandardBreakdown: {
    goalClarity: number;
    qualityPursuit: number;
    executionRigor: number;
  };
  analysis: string;
}

export interface QuoteV1 {
  speaker: string;
  text: string;
}

export interface LeaderAdviceV1 {
  action: 'frame_for_learning' | 'create_psychological_safety' | 'learn_from_failure' | 'cross_boundaries';
  advice: string;
  reasoning: string;
}

export interface CommunicationParticipantV1 {
  name: string;
  speakingShare: number;
  inquiryScore: number;
  advocacyScore: number;
  effectiveSentences: number;
}

export type PlayerRoleV1 = 'mover' | 'follower' | 'opposer' | 'bystander' | 'silent';

export interface NetworkNodeV1 {
  name: string;
  role?: string;
  playerRole: PlayerRoleV1;
  playerReason: string;
  speakingShare?: number;
}

export interface NetworkEdgeV1 {
  source: string;
  target: string;
  weight: 'strong' | 'moderate' | 'light';
  nature?: string;
}

export interface DialogueNetworkV1 {
  nodes: NetworkNodeV1[];
  edges: NetworkEdgeV1[];
  analysis: string;
  riskAssessment: string;
}

export interface MeetingMetadataV1 {
  meetingType: string;
  projectPhase?: 'Start-up' | 'Post-startup';
  totalSentences: number;
  effectiveSentences: number;
  qualityFlag: 'normal' | 'low_sample' | 'unbalanced';
}

export interface UnfinishedDialogueV1 {
  topic: string;
  whyUnfinished: string;
  whyNeedsClosure: string;
}

export interface UnseenDisagreementV1 {
  topic: string;
  whatEachSideSays: string;
  whyItMatters: string;
}

export interface KeyAssumptionV1 {
  assumption: string;
  whyToVerify: string;
}

export interface AnalysisResultV1 {
  reportTimestamp: string;
  metadata: MeetingMetadataV1;
  summary: string;
  behaviors: TeamBehaviorsV1;
  teamState: TeamStateV1;
  keyAssumptions: KeyAssumptionV1[];
  unfinishedDialogues: UnfinishedDialogueV1[];
  unseenDisagreements: UnseenDisagreementV1[];
  leaderAdvice: LeaderAdviceV1;
  communication: CommunicationParticipantV1[];
  dialogueNetwork?: DialogueNetworkV1;
}

export enum AnalysisStatusV1 {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  COMPLETE = 'COMPLETE',
  ERROR = 'ERROR',
}

export interface BatchItemV1 {
  id: string;
  file: File;
  status: 'PENDING' | 'ANALYZING' | 'COMPLETE' | 'ERROR';
  taskId?: string;
  result?: AnalysisResultV1;
  error?: string;
}
