/**
 * 类型聚合层。
 *
 * V1 类型（已冻结）：对应 schemaVersion=1 的旧报告，详见 `./v1`。
 * V2 类型（当前活跃）：对应 schemaVersion=2 的新报告，详见 `./v2`。
 *
 * 默认导出（无后缀）指向 V2：
 * - `AnalysisResult` = `AnalysisResultV2`
 * - `BatchItem` = `BatchItemV2`
 * - `TeamZone` = `TeamZoneV2`
 *
 * V1 渲染器（AnalysisDashboardV1）及 V1 图表组件应显式 import V1 后缀类型。
 */

export type {
  TeamZoneV1,
  BehaviorMetricV1,
  TeamBehaviorsV1,
  TeamStateV1,
  QuoteV1,
  LeaderAdviceV1,
  CommunicationParticipantV1,
  PlayerRoleV1,
  NetworkNodeV1,
  NetworkEdgeV1,
  DialogueNetworkV1,
  MeetingMetadataV1,
  UnfinishedDialogueV1,
  UnseenDisagreementV1,
  KeyAssumptionV1,
  AnalysisResultV1,
  BatchItemV1,
} from './v1';

export { AnalysisStatusV1 } from './v1';

export type {
  TeamZoneV2,
  BoundaryDimensionV2,
  ParticipantTypeV2,
  BehaviorMetricV2,
  TeamBehaviorsV2,
  EvidenceDirectionV2,
  EvidenceConfidenceV2,
  DimensionAssessmentV2,
  LearningBehaviorObservationV2,
  TeamStateV2,
  LeaderAdviceV2,
  CommunicationParticipantV2,
  PlayerRoleV2,
  NetworkNodeV2,
  NetworkEdgeV2,
  DialogueNetworkV2,
  MeetingMetadataV2,
  CrossBoundaryLearningV2,
  UnfinishedDialogueV2,
  UnseenDisagreementV2,
  AnalysisResultV2,
  BatchItemV2,
} from './v2';

/**
 * 默认类型别名（指向 V2，新代码应使用这些）。
 */
import type { TeamZoneV2, AnalysisResultV2, BatchItemV2 } from './v2';
export type TeamZone = TeamZoneV2;
export type AnalysisResult = AnalysisResultV2;
export type BatchItem = BatchItemV2;
