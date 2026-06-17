export interface BehaviorMetric {
  level: 'Red' | 'Blue' | 'Green' | 'Grey';
  score: number;
  evidence: string[];
  summary: string;
}

export interface TeamBehaviors {
  speakingUp: BehaviorMetric;
  collaboration: BehaviorMetric;
  experimentation: BehaviorMetric;
  reflection: BehaviorMetric;
}

export interface TeamState {
  zone: 'Apathy' | 'Comfort' | 'Anxiety' | 'Learning' | 'Difficult to Judge';
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

export interface Quote {
  speaker: string;
  text: string;
}

export interface LeaderAdvice {
  action: 'frame_for_learning' | 'create_psychological_safety' | 'learn_from_failure' | 'cross_boundaries';
  advice: string;
  reasoning: string;
}

export interface CommunicationParticipant {
  name: string;
  speakingShare: number;
  inquiryScore: number;
  advocacyScore: number;
  effectiveSentences: number;
}

export interface MeetingMetadata {
  meetingType: string;
  projectPhase?: 'Start-up' | 'Post-startup';
  totalSentences: number;
  effectiveSentences: number;
  qualityFlag: 'normal' | 'low_sample' | 'unbalanced';
}

export interface AnalysisResult {
  reportTimestamp: string;
  metadata: MeetingMetadata;
  summary: string;
  behaviors: TeamBehaviors;
  teamState: TeamState;
  leaderAdvice: LeaderAdvice;
  communication: CommunicationParticipant[];
}

export enum AnalysisStatus {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  COMPLETE = 'COMPLETE',
  ERROR = 'ERROR',
}

export interface BatchItem {
  id: string;
  file: File;
  status: 'PENDING' | 'ANALYZING' | 'COMPLETE' | 'ERROR';
  result?: AnalysisResult;
  error?: string;
}
