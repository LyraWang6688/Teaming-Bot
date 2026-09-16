import type {
  AnalysisResultV2,
  BoundaryDimensionV2,
  CommunicationParticipantV2,
  EvidenceDirectionV2,
  LeaderAdviceV2,
  NetworkEdgeV2,
  NetworkNodeV2,
  ParticipantTypeV2,
  PlayerRoleV2,
  TeamZoneV2,
} from '@/types';
import { invokeJson } from './provider';
import { parseTranscript, type ParsedTranscript } from './transcript';
import * as crypto from 'node:crypto';
import {
  estimateEvidencePromptTokens,
  selectEvidenceOutputBudget,
} from './evidenceBudget';
import {
  EVIDENCE_SYSTEM_PROMPT,
  REPORT_SYSTEM_PROMPT,
  buildEvidenceRequest,
  buildReportRequest,
} from './prompts';
import {
  canonicalZoneLabel,
  deriveAdjacentZone,
  deriveInsufficientBoundary,
  derivePositionHint,
  deriveZone,
} from './decision';
import { normalizeEvidenceReferences } from './evidence';

const VALID_ROLES = new Set<PlayerRoleV2>(['mover', 'follower', 'opposer', 'bystander', 'silent']);
const VALID_ACTIONS = new Set<LeaderAdviceV2['action']>([
  'frame_for_learning',
  'create_psychological_safety',
  'learn_from_failure',
  'cross_boundaries',
]);
const VALID_DIRECTIONS = new Set<EvidenceDirectionV2>(['higher', 'lower', 'insufficient']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low'] as const);
const VALID_PARTICIPANT_TYPES = new Set<ParticipantTypeV2>(['internal', 'external', 'facilitator', 'unknown']);
const VALID_BOUNDARIES = new Set<BoundaryDimensionV2>(['psychologicalSafety', 'accountability', 'none']);
const VALID_OUTCOME_STATUS = new Set(['resolved', 'partially_resolved', 'unresolved', 'not_applicable']);
const VALID_VALIDATION_STATUS = new Set(['present', 'absent', 'not_applicable']);
const VALID_OWNERSHIP_PATTERNS = new Set(['shared', 'concentrated', 'unclear']);
const VALID_STANDARD_STRENGTHS = new Set(['explicit', 'emerging', 'absent']);
const VALID_VALIDATION_MODES = new Set(['committed_test', 'information_request', 'absent']);
const VALID_MONITORING_MODES = new Set(['correction_loop', 'check_in', 'absent']);

interface LockedParticipant {
  name: string;
  participantType: ParticipantTypeV2;
  playerRole: PlayerRoleV2;
}

interface LockedDecision {
  psychologicalSafety: { direction: EvidenceDirectionV2; confidence: 'high' | 'medium' | 'low' };
  accountability: { direction: EvidenceDirectionV2; confidence: 'high' | 'medium' | 'low' };
  zone: TeamZoneV2;
  adjacentZone?: Exclude<TeamZoneV2, 'Difficult to Judge'>;
  boundaryDimension: BoundaryDimensionV2;
  zoneLabel: string;
  positionHint: 'center' | 'near_horizontal_boundary' | 'near_vertical_boundary';
  crossBoundaryPresent: boolean;
  participants: LockedParticipant[];
  interactions: NetworkEdgeV2[];
}

export async function analyzeTranscript(rawTranscript: string): Promise<AnalysisResultV2> {
  const analysisStartedAt = Date.now();
  const parsed = parseTranscript(rawTranscript);
  if (parsed.raw.length < 120) throw new Error('会议文本过短，请上传包含完整发言记录的文件。');

  const contentHash = crypto
    .createHash('sha256')
    .update(parsed.raw)
    .digest('hex')
    .slice(0, 16);
  if (parsed.speakers.length < 2) {
    throw new Error('未识别到至少两位实质发言者，暂不生成团队互动报告。');
  }

  const evidenceBudget = selectEvidenceOutputBudget(
    estimateEvidencePromptTokens(parsed.raw.length),
  );
  console.info('[Analysis start]', {
    contentHash,
    charCount: parsed.raw.length,
    turnCount: parsed.turns.length,
    speakerCount: parsed.speakers.length,
    estimatedPromptTokens: evidenceBudget.estimatedPromptTokens,
    evidenceBudgetTier: evidenceBudget.tier,
    chosenEvidenceMaxTokens: evidenceBudget.maxTokens,
  });

  const timing = {
    evidenceMs: 0,
    reportAndAdviceMs: 0,
  };
  let evidenceAttempts = 0;
  let evidence: Record<string, unknown> | null = null;
  let evidenceIssues: string[] = [];
  const pipelineNotes: string[] = [];
  let usedFallbackEvidence = false;
  let usedFallbackReport = false;
  let evidenceStart = 0;
  try {
    evidenceStart = Date.now();
    evidenceAttempts += 1;
    const rawEvidence = await invokeJson([
      { role: 'system', content: EVIDENCE_SYSTEM_PROMPT },
      { role: 'user', content: buildEvidenceRequest(parsed.raw, buildDeterministicFacts(parsed)) },
    ], {
      label: '证据提取',
      temperature: 0.05,
      maxTokens: evidenceBudget.maxTokens,
      thinking: 'disabled',
    });
    const normalized = normalizeEvidenceReferences(rawEvidence, parsed);
    evidence = normalized.evidence;
    evidenceIssues = [...normalized.issues, ...inspectEvidence(evidence, parsed)];
    timing.evidenceMs = Date.now() - evidenceStart;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    evidenceIssues = [`证据提取失败：${message}`];
    pipelineNotes.push(evidenceIssues[0]);
    console.warn('[Evidence pipeline] 模型调用失败，将降级', error);
    timing.evidenceMs = Date.now() - evidenceStart;
  }
  if (!evidence) {
    evidence = buildFallbackEvidence(parsed);
    usedFallbackEvidence = true;
    pipelineNotes.push('模型证据阶段未能返回可用结构，已使用保守证据包生成报告。');
  } else if (evidenceIssues.length) {
    pipelineNotes.push(`部分证据未通过自动校验，已舍弃或按保守口径处理：${evidenceIssues.join('；')}`);
    console.warn('[Evidence quality] 保留可用证据并继续生成报告', evidenceIssues);
  }
  const lockedDecision = buildLockedDecision(evidence, parsed);

  let candidate: Record<string, unknown> | null = null;
  let qualityIssues: string[] = [];
  if (usedFallbackEvidence) {
    candidate = buildFallbackReport(lockedDecision);
    usedFallbackReport = true;
    pipelineNotes.push('证据阶段未完成，已跳过无依据的模型写作并直接生成基础事实版。');
  } else {
    const request = buildReportRequest(
      JSON.stringify(evidence, null, 2),
      JSON.stringify(lockedDecision, null, 2),
    );
    const reportStart = Date.now();
    const reportTask = invokeJson([
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: request },
    ], {
      label: '报告写作',
      temperature: 0.35,
      maxTokens: 7000,
      thinking: 'disabled',
    });
    const adviceTask = generateLeaderAdvice(evidence, lockedDecision);
    const [reportOutcome, adviceOutcome] = await Promise.allSettled([reportTask, adviceTask]);
    timing.reportAndAdviceMs = Date.now() - reportStart;
    if (reportOutcome.status === 'fulfilled') {
      candidate = reportOutcome.value;
    } else {
      const message = reportOutcome.reason instanceof Error ? reportOutcome.reason.message : String(reportOutcome.reason);
      pipelineNotes.push(`报告写作失败：${message}`);
      console.warn('[Report pipeline] 模型调用失败，将降级', reportOutcome.reason);
    }
    if (candidate && adviceOutcome.status === 'fulfilled') {
      candidate = { ...candidate, leaderAdvice: adviceOutcome.value.leaderAdvice };
    } else if (adviceOutcome.status === 'rejected') {
      console.warn('[Report quality] 并行生成的 Part 4 未完成，保留主体报告中的建议', adviceOutcome.reason);
    }
  }
  if (candidate) qualityIssues = inspectCandidate(candidate, parsed, lockedDecision);
  if (!candidate) {
    candidate = buildFallbackReport(lockedDecision);
    usedFallbackReport = true;
    pipelineNotes.push('模型写作阶段未能返回可用结构，已生成保守版完整报告。');
  }
  if (qualityIssues.length) {
    pipelineNotes.push(`报告已自动补齐，仍有以下表达局限：${qualityIssues.join('；')}`);
    console.warn('[Report quality] 质量问题不再阻断报告，已自动补齐', qualityIssues);
  }
  const completed = completeReportCandidate(candidate, lockedDecision);
  const result = normalizeReport(completed, lockedDecision, parsed);
  result.metadata.analysisMode = usedFallbackEvidence || usedFallbackReport
    ? 'basic_fallback'
    : pipelineNotes.length
      ? 'recovered'
      : 'full';
  if (pipelineNotes.length) {
    result.metadata.pipelineNotice = result.metadata.analysisMode === 'basic_fallback'
      ? '模型服务未完成核心分析。当前仅提供基础事实版，不应把"暂不定位"理解为正式团队诊断；请稍后重试。'
      : '报告经过自动修复后完成；证据不足处未作强判断。';
    result.metadata.inputQualityNote = [result.metadata.inputQualityNote, result.metadata.pipelineNotice].filter(Boolean).join(' ');
  }
  const totalMs = Date.now() - analysisStartedAt;
  console.info('[Analysis complete]', {
    contentHash,
    totalMs,
    evidenceMs: timing.evidenceMs,
    evidenceAttempts,
    reportAndAdviceMs: timing.reportAndAdviceMs,
    analysisMode: result.metadata.analysisMode,
    zone: result.teamState?.zone ?? null,
    evidenceBudgetTier: evidenceBudget.tier,
  });
  return result;
}

function buildDeterministicFacts(parsed: ParsedTranscript) {
  return JSON.stringify({
    durationLabel: parsed.durationLabel,
    participantCount: parsed.speakers.length,
    speakers: parsed.speakers,
    effectiveTurnCount: parsed.effectiveTurnCount,
    qualityNotes: parsed.qualityNotes,
  }, null, 2);
}

function inspectEvidence(raw: Record<string, unknown>, parsed: ParsedTranscript) {
  const issues: string[] = [];
  const psychologicalSafety = asRecord(raw.psychologicalSafety);
  const accountability = asRecord(raw.accountability);
  const meeting = asRecord(raw.meeting);
  const boundary = asRecord(raw.boundary);
  const participants = asArray(raw.participants).map(asRecord);
  const knownNames = new Set(parsed.speakers.map((speaker) => speaker.name));
  const participantNames = new Set(participants.map((participant) => asText(participant.name)).filter(Boolean));

  const missing = [...knownNames].filter((name) => !participantNames.has(name));
  const unknown = [...participantNames].filter((name) => !knownNames.has(name));
  if (missing.length) issues.push(`证据包缺少发言者：${missing.join('、')}`);
  if (unknown.length) issues.push(`证据包出现不存在的发言者：${unknown.join('、')}`);

  participants.forEach((participant) => {
    const name = asText(participant.name) || '未命名发言者';
    if (!VALID_ROLES.has(asText(participant.primaryFunction) as PlayerRoleV2)) issues.push(`${name} 缺少有效主要功能`);
    if (!VALID_PARTICIPANT_TYPES.has(asText(participant.participantType) as ParticipantTypeV2)) issues.push(`${name} 缺少有效参与者类型`);
    const primaryFunction = asText(participant.primaryFunction) as PlayerRoleV2;
    const functionEvents = asArray(participant.functionEvents).map(asRecord);
    const roleEvents = functionEvents.filter((event) => asText(event.function) === primaryFunction && asText(event.event));
    if (primaryFunction === 'silent' && functionEvents.length) issues.push(`${name} 有功能事件却被标为未观察到明显功能`);
    if (primaryFunction !== 'silent' && !roleEvents.length) issues.push(`${name} 的主要功能没有对应的可观察事件`);
  });

  asArray(raw.semanticInteractions).map(asRecord).forEach((interaction) => {
    const source = asText(interaction.source);
    const target = asText(interaction.target);
    if (!knownNames.has(source) || !knownNames.has(target) || source === target) {
      issues.push(`语义互动引用无效：${source || '未知'} → ${target || '未知'}`);
    }
    if (!asText(interaction.evidence)) issues.push(`语义互动缺少证据：${source} → ${target}`);
  });

  if (!VALID_DIRECTIONS.has(asText(psychologicalSafety.direction) as EvidenceDirectionV2)) issues.push('心理安全方向无效');
  if (!VALID_DIRECTIONS.has(asText(accountability.direction) as EvidenceDirectionV2)) issues.push('高要求与问责方向无效');
  if (!VALID_CONFIDENCE.has(asText(psychologicalSafety.confidence) as 'high' | 'medium' | 'low')) issues.push('心理安全置信度无效');
  if (!VALID_CONFIDENCE.has(asText(accountability.confidence) as 'high' | 'medium' | 'low')) issues.push('高要求与问责置信度无效');
  if (!VALID_OUTCOME_STATUS.has(asText(accountability.coreOutcomeStatus))) issues.push('核心产出状态无效');
  if (!VALID_VALIDATION_STATUS.has(asText(accountability.validationCommitment))) issues.push('验证承诺状态无效');
  if (!VALID_OWNERSHIP_PATTERNS.has(asText(accountability.ownershipPattern))) issues.push('责任拥有模式无效');
  if (!VALID_STANDARD_STRENGTHS.has(asText(accountability.standardStrength))) issues.push('质量标准成熟度无效');
  if (!VALID_VALIDATION_MODES.has(asText(accountability.validationMode))) issues.push('验证方式成熟度无效');
  if (!VALID_MONITORING_MODES.has(asText(accountability.monitoringMode))) issues.push('追踪纠偏成熟度无效');

  if (asText(psychologicalSafety.direction) === 'higher' && !asArray(psychologicalSafety.internalSignals).length) {
    issues.push('心理安全判为 higher 但没有内部成员"人际风险表达→回应"的事件链');
  }

  const demandEvidence = [
    ...asArray(accountability.demandSignals),
    ...asArray(accountability.standardBasisSignals),
    ...asArray(accountability.validationSignals),
    ...asArray(accountability.monitoringSignals),
  ];
  if (asText(accountability.direction) === 'higher' && !demandEvidence.length) {
    issues.push('高要求与问责判为 higher，但没有目标、标准、期限、验收、追踪或后果证据');
  }

  const crossBoundary = Boolean(meeting.crossBoundary);
  if (typeof meeting.crossBoundary !== 'boolean') issues.push('跨边界标记必须是布尔值');
  const hasExternal = participants.some((participant) => asText(participant.participantType) === 'external');
  if (crossBoundary && !hasExternal) issues.push('会议判为跨边界，但没有识别出外部参与者');

  const boundaryDimension = asText(boundary.dimension) as BoundaryDimensionV2;
  if (!VALID_BOUNDARIES.has(boundaryDimension)) issues.push('边界维度无效');
  const zone = deriveZone(
    normalizeDirection(psychologicalSafety.direction),
    normalizeDirection(accountability.direction),
  );
  if (zone === 'Difficult to Judge' && boundaryDimension !== 'none') {
    issues.push('证据不足时不得给出相邻区域边界');
  }
  return [...new Set(issues)];
}

function buildLockedDecision(raw: Record<string, unknown>, parsed: ParsedTranscript): LockedDecision {
  const psychologicalSafetyRaw = asRecord(raw.psychologicalSafety);
  const accountabilityRaw = asRecord(raw.accountability);
  const boundaryRaw = asRecord(raw.boundary);
  const meeting = asRecord(raw.meeting);
  const participantByName = new Map(asArray(raw.participants).map(asRecord).map((participant) => [asText(participant.name), participant]));
  const psychologicalSafety = {
    direction: normalizeDirection(psychologicalSafetyRaw.direction),
    confidence: normalizeConfidence(psychologicalSafetyRaw.confidence),
  };
  const accountability = {
    direction: normalizeDirection(accountabilityRaw.direction),
    confidence: normalizeConfidence(accountabilityRaw.confidence),
  };
  const zone = deriveZone(psychologicalSafety.direction, accountability.direction);
  const requestedBoundary = asText(boundaryRaw.dimension) as BoundaryDimensionV2;
  const insufficientBoundary = deriveInsufficientBoundary(psychologicalSafety.direction, accountability.direction);
  const calibratedBoundary = zone === 'Comfort' && asBoolean(accountabilityRaw.nearHigherBoundary)
    ? 'accountability'
    : requestedBoundary;
  const boundaryDimension = insufficientBoundary !== 'none'
    ? insufficientBoundary
    : validateBoundaryDimension(
      zone,
      calibratedBoundary,
      psychologicalSafetyRaw,
      accountabilityRaw,
    );
  const adjacentZone = deriveAdjacentZone(zone, boundaryDimension);
  const participants: LockedParticipant[] = parsed.speakers.map((speaker) => {
    const participant = participantByName.get(speaker.name) || {};
    const candidateRole = asText(participant.primaryFunction) as PlayerRoleV2;
    const candidateType = asText(participant.participantType) as ParticipantTypeV2;
    return {
      name: speaker.name,
      playerRole: derivePrimaryRole(participant, candidateRole),
      participantType: VALID_PARTICIPANT_TYPES.has(candidateType) ? candidateType : 'unknown',
    };
  });
  const knownNames = new Set(parsed.speakers.map((speaker) => speaker.name));
  const rawInteractions = asArray(raw.semanticInteractions).map(asRecord)
    .filter((interaction) => {
      const source = asText(interaction.source);
      const target = asText(interaction.target);
      return knownNames.has(source) && knownNames.has(target) && source !== target;
    })
    .map((interaction) => ({
      source: asText(interaction.source),
      target: asText(interaction.target),
      nature: asText(interaction.nature) || '直接语义互动',
      count: Math.max(1, asNumber(interaction.count) || 1),
    }));
  const interactionGroups = new Map<string, typeof rawInteractions>();
  rawInteractions.forEach((interaction) => {
    const key = `${interaction.source}\u0000${interaction.target}`;
    interactionGroups.set(key, [...(interactionGroups.get(key) || []), interaction]);
  });
  const interactions: NetworkEdgeV2[] = [...interactionGroups.values()].map((group) => {
    const count = group.reduce((sum, interaction) => sum + interaction.count, 0);
    return {
      source: group[0].source,
      target: group[0].target,
      nature: [...new Set(group.map((interaction) => interaction.nature))].join('、'),
      count,
      weight: count >= 5 ? 'strong' : count >= 2 ? 'moderate' : 'light',
    };
  });
  return {
    psychologicalSafety,
    accountability,
    zone,
    adjacentZone,
    boundaryDimension,
    zoneLabel: canonicalZoneLabel(zone, adjacentZone, insufficientBoundary !== 'none'),
    positionHint: derivePositionHint(boundaryDimension),
    crossBoundaryPresent: asBoolean(meeting.crossBoundary),
    participants,
    interactions,
  };
}

function derivePrimaryRole(participant: Record<string, unknown>, requested: PlayerRoleV2): PlayerRoleV2 {
  const counts = new Map<PlayerRoleV2, number>([
    ['mover', 0], ['follower', 0], ['opposer', 0], ['bystander', 0],
  ]);
  asArray(participant.functionEvents).map(asRecord).forEach((event) => {
    const role = asText(event.function) as PlayerRoleV2;
    if (counts.has(role) && asText(event.event)) counts.set(role, (counts.get(role) || 0) + 1);
  });
  const highest = Math.max(...counts.values());
  if (highest === 0) return 'silent';
  const tied = [...counts.entries()].filter(([, count]) => count === highest).map(([role]) => role);
  if (tied.includes(requested)) return requested;
  return tied[0];
}

function validateBoundaryDimension(
  zone: TeamZoneV2,
  requested: BoundaryDimensionV2,
  psychologicalSafety: Record<string, unknown>,
  accountability: Record<string, unknown>,
): BoundaryDimensionV2 {
  if (zone === 'Difficult to Judge' || !VALID_BOUNDARIES.has(requested) || requested === 'none') return 'none';
  if (requested === 'psychologicalSafety') {
    const hasPositive = asArray(psychologicalSafety.internalSignals).length > 0;
    const hasConstraint = asArray(psychologicalSafety.constraintSignals).length > 0
      || asArray(psychologicalSafety.counterEvidence).length > 0;
    return hasPositive && hasConstraint ? requested : 'none';
  }
  const hasDemand = asArray(accountability.demandSignals).length > 0
    || asArray(accountability.standardBasisSignals).length > 0
    || asArray(accountability.validationSignals).length > 0
    || asArray(accountability.monitoringSignals).length > 0;
  const hasCounter = asArray(accountability.counterEvidence).length > 0;
  return hasDemand && hasCounter ? requested : 'none';
}

function inspectCandidate(raw: Record<string, unknown>, parsed: ParsedTranscript, locked: LockedDecision) {
  const issues: string[] = [];
  const teamState = asRecord(raw.teamState);
  const network = asRecord(raw.dialogueNetwork);
  const nodes = asArray(network.nodes).map(asRecord);
  const known = new Set(parsed.speakers.map((speaker) => speaker.name));
  const nodeNames = new Set(nodes.map((node) => asText(node.name)).filter(Boolean));
  const missing = [...known].filter((name) => !nodeNames.has(name));
  const unknown = [...nodeNames].filter((name) => !known.has(name));
  if (missing.length) issues.push(`缺少发言者：${missing.join('、')}`);
  if (unknown.length) issues.push(`出现了不存在的发言者：${unknown.join('、')}`);
  const conflictingRoles = nodes.filter((node) => {
    const returnedRole = asText(node.playerRole);
    const lockedRole = locked.participants.find((participant) => participant.name === asText(node.name))?.playerRole;
    return returnedRole && lockedRole && returnedRole !== lockedRole;
  }).map((node) => asText(node.name));
  if (conflictingRoles.length) issues.push(`报告写作阶段擅自改变了主要功能：${conflictingRoles.join('、')}`);
  const returnedZone = asText(teamState.zone);
  if (returnedZone && returnedZone !== locked.zone) issues.push('报告写作阶段擅自改变了区域判断');
  const returnedLabel = asText(teamState.zoneLabel);
  if (returnedLabel && returnedLabel !== locked.zoneLabel) issues.push('报告写作阶段擅自改写了区域或相邻区域标签');
  if (locked.zone !== 'Difficult to Judge' && !asText(teamState.analysis).includes(locked.zoneLabel)) {
    issues.push(`Part 1 整体解读没有明确使用锁定定位"${locked.zoneLabel}"`);
  }
  if (locked.crossBoundaryPresent && !asText(asRecord(raw.crossBoundaryLearning).summary)) {
    issues.push('跨边界会议缺少跨边界学习分析');
  }
  const publicCopy = [
    raw.summary,
    teamState.analysis,
    asRecord(teamState.psychologicalSafety).summary,
    asRecord(teamState.accountability).summary,
    network.analysis,
    network.noteworthyPattern,
  ].map(asText).join(' ');
  if (/accountability|psychologicalSafety|lockedDecision|\bhigher\b|\blower\b/i.test(publicCopy)) {
    issues.push('前台文字暴露了后台字段名');
  }
  if (asText(teamState.analysis).length < 80) issues.push('Part 1 整体解读过于简略');
  if (asText(network.analysis).length < 75) issues.push('Part 2 互动概览过于简略');
  const shortNodes = nodes.filter((node) => asText(node.playerReason).length < 50).map((node) => asText(node.name));
  if (shortNodes.length) issues.push(`成员观察过于简略：${shortNodes.join('、')}`);
  const advice = asArray(raw.leaderAdvice).map(asRecord);
  if (!advice.length || advice.length > 2) issues.push('领导建议应为 1 条，特殊情况最多 2 条');
  const invalidActions = advice.filter((item) => !VALID_ACTIONS.has(asText(item.action) as LeaderAdviceV2['action']));
  if (invalidActions.length) issues.push('领导建议没有映射到 Organizing to Learn 的四个领导行为');
  const thinAdvice = advice.some((item) => {
    const main = asText(item.advice);
    const supporting = [item.reasoning, item.timing, item.signalToWatch].map(asText).join('');
    return main.length < 24 || main.length + supporting.length < 120;
  });
  if (thinAdvice) issues.push('领导建议整体过于简略');
  if (advice.some((item) => asText(item.advice).length > 75)) issues.push('领导建议的"建议做什么"过于细碎');
  const repeatedMechanical = advice.some((item) => /^(?:下次会议开始时|首先说|为学习框定情境)/.test(asText(item.advice)));
  if (repeatedMechanical) issues.push('领导建议使用了被禁止的机械起手式');
  const unfinished = asArray(raw.unfinishedDialogues).map(asRecord);
  unfinished.forEach((item, index) => {
    if (!asText(item.conversationSoFar) && !asText(item.whyUnfinished)) issues.push(`未完形对话 ${index + 1} 缺少"对话走到了哪里"`);
    if (!asText(item.whatRemains) && !asText(item.whyNeedsClosure)) issues.push(`未完形对话 ${index + 1} 缺少"尚未完成的是"`);
  });
  const disagreements = asArray(raw.unseenDisagreements).map(asRecord);
  disagreements.forEach((item, index) => {
    if (!asText(item.differentConcerns) && !asText(item.whatEachSideSays)) issues.push(`非共识 ${index + 1} 缺少可观察的不同关注`);
    if (!asText(item.sharedGoal)) issues.push(`非共识 ${index + 1} 缺少共同目标`);
  });
  const duplicateTopics = unfinished
    .map((item) => asText(item.topic))
    .filter((topic) => topic && disagreements.some((item) => asText(item.topic) === topic));
  if (duplicateTopics.length) issues.push(`Part 3 同一主题被重复归类：${duplicateTopics.join('、')}`);
  return issues;
}

async function generateLeaderAdvice(evidence: Record<string, unknown>, locked: LockedDecision) {
  const psychologicalSafety = asRecord(evidence.psychologicalSafety);
  const accountability = asRecord(evidence.accountability);
  const context = {
    meeting: evidence.meeting,
    coreTension: evidence.coreTension,
    learningProcesses: asArray(evidence.learningProcesses).slice(0, 4),
    psychologicalSafety: {
      direction: psychologicalSafety.direction,
      internalSignals: asArray(psychologicalSafety.internalSignals).slice(0, 3),
      constraintSignals: asArray(psychologicalSafety.constraintSignals).slice(0, 3),
      limitation: psychologicalSafety.limitation,
    },
    accountability: {
      direction: accountability.direction,
      demandSignals: asArray(accountability.demandSignals).slice(0, 2),
      standardBasisSignals: asArray(accountability.standardBasisSignals).slice(0, 2),
      validationSignals: asArray(accountability.validationSignals).slice(0, 2),
      monitoringSignals: asArray(accountability.monitoringSignals).slice(0, 2),
      limitation: accountability.limitation,
    },
    unfinishedCandidates: asArray(evidence.unfinishedCandidates).slice(0, 2),
    disagreementCandidates: asArray(evidence.disagreementCandidates).slice(0, 2),
    actionLeverage: evidence.actionLeverage,
    lockedDecision: {
      zone: locked.zone,
      zoneLabel: locked.zoneLabel,
      crossBoundaryPresent: locked.crossBoundaryPresent,
    },
  };
  const repaired = await invokeJson([
    {
      role: 'system',
      content: `你是团队学习报告的 Part 4 编辑。根据已经锁定的本次会议证据，生成一条最优先的领导者建议。不得改变区域判断，不添加证据中没有的事实。必须准确映射 Amy Edmondson 的四个 Organizing to Learn 领导行为：frame_for_learning=把工作框定为需要学习；create_psychological_safety=营造能承担人际风险的环境；learn_from_failure=把失败、偏差与意外转化为学习；cross_boundaries=跨越专业、组织或文化边界获取信息并协调。邀请参与只是营造心理安全的一种做法。建议做什么只写一个高层动作，不堆步骤，不默认写成"下次会议开始时首先说"或"为学习框定情境"。只返回 JSON。`,
    },
    {
      role: 'user',
      content: `返回 {"leaderAdvice":[{"action":"frame_for_learning|create_psychological_safety|learn_from_failure|cross_boundaries","advice":"35–75字，只写一个高层动作","reasoning":"50–100字","timing":"自然说明适用情境","signalToWatch":"用可观察行为说明如何验收","optionalScript":"没有必要则为空"}]}\n\n${JSON.stringify(context)}`,
    },
  ], {
    label: '领导行动建议',
    temperature: 0.35,
    maxTokens: 1800,
    thinking: 'disabled',
  });
  const advice = asArray(repaired.leaderAdvice);
  if (!advice.length) throw new Error('Part 4 修订未返回建议');
  return { leaderAdvice: advice };
}

function buildFallbackEvidence(parsed: ParsedTranscript): Record<string, unknown> {
  return {
    meeting: {
      type: '会议性质暂未判断',
      purpose: '现有结构化证据不足以稳定概括会议目的。',
      context: '仅基于本次会议转写生成保守版报告。',
      crossBoundary: false,
      inputQuality: '模型证据提取不可用，已启用保守降级。',
    },
    coreTension: '现有证据不足以对团队学习状态作出可靠定位。',
    learningProcesses: [],
    psychologicalSafety: {
      direction: 'insufficient', confidence: 'low', scope: 'unknown',
      internalSignals: [], constraintSignals: [], crossBoundarySignals: [], counterEvidence: [],
      limitation: '未取得可回溯的内部人际风险与回应事件链。',
    },
    accountability: {
      direction: 'insufficient', confidence: 'low', coreOutcomeStatus: 'not_applicable',
      validationCommitment: 'not_applicable', ownershipPattern: 'unclear',
      standardStrength: 'absent', validationMode: 'absent', monitoringMode: 'absent',
      demandSignals: [], standardBasisSignals: [], validationSignals: [], monitoringSignals: [],
      sharedOwnershipSignals: [], closureSignals: [], counterEvidence: [],
      limitation: '未取得可回溯的目标、标准、期限、验收或追踪证据。',
    },
    boundary: { dimension: 'none', reason: '证据不足时不判断相邻区域。' },
    participants: parsed.speakers.map((speaker) => ({
      name: speaker.name,
      aliases: [],
      participantType: 'unknown',
      typeEvidence: '',
      primaryFunction: 'silent',
      functionEvents: [],
      secondaryFunctions: [],
    })),
    semanticInteractions: [],
    unfinishedCandidates: [],
    disagreementCandidates: [],
    actionLeverage: '先补足能够支持团队学习判断的关键事实。',
  };
}

function buildFallbackReport(locked: LockedDecision): Record<string, unknown> {
  const directionCopy = (dimension: 'psychologicalSafety' | 'accountability', direction: EvidenceDirectionV2) => {
    const name = dimension === 'psychologicalSafety' ? '心理安全' : '高要求与问责';
    if (direction === 'higher') return `本次会议中观察到支持${name}较高的信号，但仍只代表这一场会议。`;
    if (direction === 'lower') return `本次会议中观察到限制${name}的信号，建议结合原文进一步核对。`;
    return `现有转写不足以稳定判断本次会议的${name}水平。`;
  };
  const fallbackAction: LeaderAdviceV2['action'] = locked.zone === 'Anxiety'
    ? 'create_psychological_safety'
    : locked.zone === 'Learning'
      ? 'learn_from_failure'
      : 'frame_for_learning';
  return {
    metadata: {
      meetingType: '会议性质暂未判断',
      meetingPurpose: '本次会议的预期产出未被可靠识别。',
      contextSummary: '报告保留了可确定的发言统计；证据不足处不作强判断。',
    },
    summary: locked.zone === 'Difficult to Judge'
      ? '本次会议保留了可确定的参与和发言事实，但关键互动证据不足，暂不对团队学习状态作强定位。'
      : `本次会议暂定位为${locked.zoneLabel}；以下解释仅保留已锁定方向，证据不足处不作进一步推断。`,
    learningBehaviors: [],
    teamState: {
      psychologicalSafety: {
        summary: directionCopy('psychologicalSafety', locked.psychologicalSafety.direction),
        evidence: [],
        limitation: '自动降级报告未补写未经验证的引用。',
      },
      accountability: {
        summary: directionCopy('accountability', locked.accountability.direction),
        evidence: [],
        limitation: '自动降级报告未补写未经验证的引用。',
      },
      analysis: locked.zone === 'Difficult to Judge'
        ? '证据不足，暂不定位。当前文本尚不能同时支持心理安全与高要求问责两个维度的可靠判断。'
        : `${locked.zoneLabel}是本次会议的谨慎定位。由于写作阶段发生自动降级，本报告不增加超出证据包的新解释。`,
      learningOpportunity: '补足关键证据｜优先回看成员提出异议、求助、报错或被追责后的回应，以及目标、标准、期限和验收如何被明确。',
      confidenceNote: '这是自动降级后的保守判断；建议结合会议原文复核。',
    },
    dialogueNetwork: {
      nodes: locked.participants.map((participant) => ({
        name: participant.name,
        playerReason: participant.playerRole === 'silent'
          ? '现有可回溯事件不足，暂未观察到其在本次会议中稳定发挥的互动功能。'
          : `证据阶段将其主要功能锁定为${participant.playerRole}；自动降级报告不再添加未经验证的个人解释。`,
        secondaryFunctions: [],
        evidence: [],
      })),
      analysis: '发言占比仍由代码确定；语义互动仅在有可回溯回应关系时连线，自动降级时不补画推测性关系。',
      noteworthyPattern: '当前最值得注意的是证据不足本身：不要把相邻发言、发言量或主持身份直接当成互动功能。',
    },
    unfinishedDialogues: [],
    unseenDisagreements: [],
    leaderAdvice: [{
      action: fallbackAction,
      advice: '先选取一段最影响本次目标的互动，在后续协作中补足其判断依据与可验证的下一步。',
      reasoning: '这样既保留行动价值，也避免在证据不足时把推测包装成确定的团队诊断。',
      timing: '在相关事项再次进入讨论或决策时进行。',
      signalToWatch: '团队能说清关键假设、判断依据以及下一步如何验证。',
      optionalScript: '',
    }],
  };
}

function completeReportCandidate(
  raw: Record<string, unknown>,
  locked: LockedDecision,
): Record<string, unknown> {
  const fallback = buildFallbackReport(locked);
  const rawMetadata = asRecord(raw.metadata);
  const fallbackMetadata = asRecord(fallback.metadata);
  const rawState = asRecord(raw.teamState);
  const fallbackState = asRecord(fallback.teamState);
  const rawNetwork = asRecord(raw.dialogueNetwork);
  const fallbackNetwork = asRecord(fallback.dialogueNetwork);
  const fillText = (value: unknown, fallbackValue: unknown) => asText(value) || asText(fallbackValue);
  return {
    ...fallback,
    ...raw,
    metadata: { ...fallbackMetadata, ...rawMetadata },
    summary: fillText(raw.summary, fallback.summary),
    learningBehaviors: Array.isArray(raw.learningBehaviors) ? raw.learningBehaviors : [],
    teamState: {
      ...fallbackState,
      ...rawState,
      psychologicalSafety: {
        ...asRecord(fallbackState.psychologicalSafety),
        ...asRecord(rawState.psychologicalSafety),
        summary: fillText(
          asRecord(rawState.psychologicalSafety).summary,
          asRecord(fallbackState.psychologicalSafety).summary,
        ),
      },
      accountability: {
        ...asRecord(fallbackState.accountability),
        ...asRecord(rawState.accountability),
        summary: fillText(
          asRecord(rawState.accountability).summary,
          asRecord(fallbackState.accountability).summary,
        ),
      },
      analysis: fillText(rawState.analysis, fallbackState.analysis),
      learningOpportunity: fillText(rawState.learningOpportunity, fallbackState.learningOpportunity),
      confidenceNote: fillText(rawState.confidenceNote, fallbackState.confidenceNote),
    },
    dialogueNetwork: {
      ...fallbackNetwork,
      ...rawNetwork,
      nodes: Array.isArray(rawNetwork.nodes) && rawNetwork.nodes.length
        ? rawNetwork.nodes
        : fallbackNetwork.nodes,
      analysis: fillText(rawNetwork.analysis, fallbackNetwork.analysis),
      noteworthyPattern: fillText(rawNetwork.noteworthyPattern, fallbackNetwork.noteworthyPattern),
    },
    unfinishedDialogues: Array.isArray(raw.unfinishedDialogues) ? raw.unfinishedDialogues : [],
    unseenDisagreements: Array.isArray(raw.unseenDisagreements) ? raw.unseenDisagreements : [],
    leaderAdvice: Array.isArray(raw.leaderAdvice) && raw.leaderAdvice.length
      ? raw.leaderAdvice
      : fallback.leaderAdvice,
  };
}

function normalizeReport(
  raw: Record<string, unknown>,
  locked: LockedDecision,
  parsed: ParsedTranscript,
): AnalysisResultV2 {
  const metadata = asRecord(raw.metadata);
  const stateRaw = asRecord(raw.teamState);
  const psychologicalSafety = normalizeDimension(
    asRecord(stateRaw.psychologicalSafety),
    locked.psychologicalSafety,
  );
  const accountability = normalizeDimension(
    asRecord(stateRaw.accountability),
    locked.accountability,
  );
  const shareMap = new Map(parsed.speakers.map((speaker) => [speaker.name, speaker.share]));
  const communication: CommunicationParticipantV2[] = parsed.speakers.map((speaker) => ({
    name: speaker.name,
    speakingShare: speaker.share,
    effectiveSentences: speaker.turnCount,
    inquiryScore: 0,
    advocacyScore: 0,
  }));

  const networkRaw = asRecord(raw.dialogueNetwork);
  const nodeByName = new Map(asArray(networkRaw.nodes).map(asRecord).map((node) => [asText(node.name), node]));
  const lockedParticipantByName = new Map(locked.participants.map((participant) => [participant.name, participant]));
  const nodes: NetworkNodeV2[] = parsed.speakers.map((speaker) => {
    const node = nodeByName.get(speaker.name) || {};
    const participant = lockedParticipantByName.get(speaker.name);
    return {
      name: speaker.name,
      playerRole: participant?.playerRole || 'silent',
      participantType: participant?.participantType || 'unknown',
      playerReason: asText(node.playerReason) || '现有转写中尚未观察到足够稳定的互动功能证据。',
      secondaryFunctions: asArray(node.secondaryFunctions).map(asText).filter(Boolean).slice(0, 2),
      evidence: asArray(node.evidence).map(asText).filter(Boolean).slice(0, 2),
      speakingShare: shareMap.get(speaker.name) || 0,
    };
  });

  const advice = asArray(raw.leaderAdvice).map(asRecord).slice(0, 2).map((item): LeaderAdviceV2 => {
    const action = asText(item.action) as LeaderAdviceV2['action'];
    return {
      action: VALID_ACTIONS.has(action) ? action : 'frame_for_learning',
      advice: compactAdvice(asText(item.advice)),
      reasoning: asText(item.reasoning),
      timing: asText(item.timing) || undefined,
      signalToWatch: asText(item.signalToWatch) || undefined,
      optionalScript: asText(item.optionalScript) || undefined,
    };
  });

  return {
    reportTimestamp: parsed.meetingStartedAt || '会议开始时间未识别',
    metadata: {
      meetingType: asText(metadata.meetingType) || '混合型会议',
      meetingPurpose: asText(metadata.meetingPurpose) || '本次会议的预期产出未被清晰说明。',
      contextSummary: asText(metadata.contextSummary) || '仅基于本次会议转写进行分析。',
      crossBoundaryPresent: locked.crossBoundaryPresent,
      totalSentences: parsed.turns.length,
      effectiveSentences: parsed.effectiveTurnCount,
      qualityFlag: parsed.effectiveTurnCount < 10 ? 'low_sample' : 'normal',
      durationLabel: parsed.durationLabel,
      participantCount: parsed.speakers.length,
      meetingStartedAt: parsed.meetingStartedAt,
      inputQualityNote: [asText(metadata.inputQualityNote), ...parsed.qualityNotes].filter(Boolean).join(' '),
      analysisMode: normalizeAnalysisMode(metadata.analysisMode),
      pipelineNotice: asText(metadata.pipelineNotice) || undefined,
    },
    summary: asText(raw.summary),
    learningBehaviors: asArray(raw.learningBehaviors).map(asRecord).slice(0, 6).map((item) => ({
      process: normalizeProcess(asText(item.process)),
      observation: asText(item.observation),
      evidence: asText(item.evidence),
      relevance: asText(item.relevance) === 'supporting' ? 'supporting' : 'central',
    })),
    teamState: {
      zone: locked.zone,
      zoneLabel: locked.zoneLabel,
      adjacentZone: locked.adjacentZone,
      boundaryDimension: locked.boundaryDimension,
      positionHint: locked.positionHint,
      psychologicalSafety,
      accountability,
      analysis: asText(stateRaw.analysis),
      learningOpportunity: asText(stateRaw.learningOpportunity),
      confidenceNote: asText(stateRaw.confidenceNote) || '这是基于单次会议可观察互动信号的谨慎判断。',
    },
    crossBoundaryLearning: locked.crossBoundaryPresent && raw.crossBoundaryLearning
      ? {
          summary: asText(asRecord(raw.crossBoundaryLearning).summary),
          evidence: asText(asRecord(raw.crossBoundaryLearning).evidence) || undefined,
        }
      : undefined,
    communication,
    dialogueNetwork: {
      nodes,
      edges: locked.interactions,
      analysis: asText(networkRaw.analysis),
      noteworthyPattern: asText(networkRaw.noteworthyPattern),
    },
    unfinishedDialogues: asArray(raw.unfinishedDialogues).map(asRecord).slice(0, 2).map((item) => ({
      topic: asText(item.topic),
      conversationSoFar: asText(item.conversationSoFar) || asText(item.whyUnfinished),
      whatRemains: asText(item.whatRemains) || asText(item.whyNeedsClosure),
    })).filter((item) => item.topic && item.conversationSoFar && item.whatRemains),
    unseenDisagreements: asArray(raw.unseenDisagreements).map(asRecord).slice(0, 2).map((item) => ({
      topic: asText(item.topic),
      differentConcerns: asText(item.differentConcerns) || asText(item.whatEachSideSays),
      sharedGoal: asText(item.sharedGoal),
      whyItMatters: asText(item.whyItMatters),
    })).filter((item) => item.topic && item.differentConcerns && item.whyItMatters),
    leaderAdvice: advice,
  };
}

function normalizeDimension(
  raw: Record<string, unknown>,
  locked: { direction: EvidenceDirectionV2; confidence: 'high' | 'medium' | 'low' },
) {
  return {
    direction: locked.direction,
    confidence: locked.confidence,
    summary: asText(raw.summary) || '现有文本未提供足够证据。',
    evidence: asArray(raw.evidence).map(asText).filter(Boolean).slice(0, 3),
    limitation: asText(raw.limitation) || undefined,
  };
}

function normalizeDirection(value: unknown): EvidenceDirectionV2 {
  const candidate = asText(value) as EvidenceDirectionV2;
  return VALID_DIRECTIONS.has(candidate) ? candidate : 'insufficient';
}

function normalizeConfidence(value: unknown): 'high' | 'medium' | 'low' {
  const candidate = asText(value) as 'high' | 'medium' | 'low';
  return VALID_CONFIDENCE.has(candidate) ? candidate : 'low';
}

function normalizeProcess(value: string) {
  return ['information_feedback', 'joint_inquiry', 'experiment_validation', 'reflection_improvement'].includes(value)
    ? value as 'information_feedback' | 'joint_inquiry' | 'experiment_validation' | 'reflection_improvement'
    : 'joint_inquiry';
}

function normalizeAnalysisMode(value: unknown): 'full' | 'recovered' | 'basic_fallback' {
  return value === 'recovered' || value === 'basic_fallback' ? value : 'full';
}

function compactAdvice(value: string) {
  if (value.length <= 75) return value;
  const colonIndex = value.search(/[：:]/u);
  const prefix = colonIndex >= 0 && colonIndex < 32 ? value.slice(0, colonIndex + 1) : '';
  const body = colonIndex >= 0 && colonIndex < 32 ? value.slice(colonIndex + 1) : value;
  const clauses = body.split(/[，,；;。]/u).map((clause) => clause.trim()).filter(Boolean);
  let result = prefix;
  for (const clause of clauses) {
    const separator = result && !result.endsWith('：') && !result.endsWith(':') ? '，' : '';
    if (`${result}${separator}${clause}。`.length > 72) break;
    result = `${result}${separator}${clause}`;
  }
  return result ? `${result.replace(/[，,；;。]+$/u, '')}。` : `${value.slice(0, 72)}。`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('；');
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).map(asText).filter(Boolean).join('。');
  }
  return '';
}
function asNumber(value: unknown): number { return typeof value === 'number' ? value : Number(value) || 0; }
function asBoolean(value: unknown): boolean { return value === true || value === 'true'; }
