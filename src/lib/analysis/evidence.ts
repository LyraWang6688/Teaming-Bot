import type { ParsedTranscript } from './transcript';

export interface EvidenceNormalizationResult {
  evidence: Record<string, unknown>;
  issues: string[];
}

export function normalizeEvidenceReferences(
  raw: Record<string, unknown>,
  parsed: ParsedTranscript,
): EvidenceNormalizationResult {
  const issues: string[] = [];
  const knownNames = parsed.speakers.map((speaker) => speaker.name);
  const exactNames = new Set(knownNames);
  const canonicalGroups = new Map<string, string[]>();
  knownNames.forEach((name) => {
    const key = normalizeParticipantToken(name);
    canonicalGroups.set(key, [...(canonicalGroups.get(key) || []), name]);
  });
  const canonicalByToken = new Map(
    [...canonicalGroups.entries()]
      .filter(([, names]) => names.length === 1)
      .map(([key, names]) => [key, names[0]]),
  );
  const sourceParticipants = asArray(raw.participants).map(asRecord);
  const normalizedParticipants = sourceParticipants.map((participant) => {
    const rawName = asText(participant.name);
    const canonicalName = exactNames.has(rawName)
      ? rawName
      : canonicalByToken.get(normalizeParticipantToken(rawName));
    return canonicalName ? { ...participant, name: canonicalName } : participant;
  });

  const aliases = new Map<string, string>();
  const ambiguousAliases = new Set<string>();
  normalizedParticipants.forEach((participant) => {
    const canonicalName = asText(participant.name);
    if (!exactNames.has(canonicalName)) return;
    asArray(participant.aliases).forEach((rawAlias) => {
      const alias = asRecord(rawAlias);
      const aliasName = asText(alias.name) || (typeof rawAlias === 'string' ? rawAlias.trim() : '');
      const aliasEvidence = asText(alias.evidence);
      const aliasKey = normalizeParticipantToken(aliasName);
      if (!aliasName || !aliasKey || aliasKey === normalizeParticipantToken(canonicalName)) return;
      const canonicalCollision = canonicalByToken.get(aliasKey);
      if (canonicalCollision && canonicalCollision !== canonicalName) {
        issues.push(`姓名别名与另一位发言者冲突：${aliasName}`);
        return;
      }
      if (!aliasEvidence || !isEvidenceTraceable(aliasEvidence, parsed.raw)) {
        issues.push(`姓名别名缺少可回溯证据：${aliasName} → ${canonicalName}`);
        return;
      }
      const existing = aliases.get(aliasKey);
      if (existing && existing !== canonicalName) {
        aliases.delete(aliasKey);
        ambiguousAliases.add(aliasKey);
        issues.push(`姓名别名对应不唯一：${aliasName}`);
        return;
      }
      if (!ambiguousAliases.has(aliasKey)) aliases.set(aliasKey, canonicalName);
    });
  });

  const keepTraceable = (records: unknown[], field: string, label: string) => records
    .map(asRecord)
    .filter((record) => {
      const evidence = asText(record[field]);
      const traceable = Boolean(evidence) && isEvidenceTraceable(evidence, parsed.raw);
      if (!traceable) issues.push(`证据引用无法回到原文：${label}`);
      return traceable;
    });
  const learningProcesses = keepTraceable(asArray(raw.learningProcesses), 'quote', '团队学习过程');
  const psychologicalSafetySource = asRecord(raw.psychologicalSafety);
  const psychologicalSafety: Record<string, unknown> = {
    ...psychologicalSafetySource,
    internalSignals: keepTraceable(
      asArray(psychologicalSafetySource.internalSignals),
      'quote',
      '心理安全内部信号',
    ),
    crossBoundarySignals: keepTraceable(
      asArray(psychologicalSafetySource.crossBoundarySignals),
      'quote',
      '心理安全跨边界信号',
    ),
    constraintSignals: keepTraceable(
      asArray(psychologicalSafetySource.constraintSignals),
      'quote',
      '心理安全限制信号',
    ),
    counterEvidence: keepTraceable(
      asArray(psychologicalSafetySource.counterEvidence),
      'quote',
      '心理安全反向证据',
    ),
  };
  if (
    asText(psychologicalSafety.direction) === 'higher'
    && !asArray(psychologicalSafety.internalSignals).length
  ) {
    psychologicalSafety.direction = 'insufficient';
    psychologicalSafety.confidence = 'low';
    psychologicalSafety.limitation = appendLimitation(
      psychologicalSafety.limitation,
      '原有积极判断缺少内部成员"承担人际风险—得到回应"的可回溯事件链，已降为证据不足。',
    );
  }
  if (
    asText(psychologicalSafety.direction) === 'insufficient'
    && asArray(psychologicalSafety.constraintSignals).length >= 2
  ) {
    psychologicalSafety.direction = 'lower';
    psychologicalSafety.confidence = 'medium';
    psychologicalSafety.limitation = appendLimitation(
      psychologicalSafety.limitation,
      '多条可回溯的限制事件已形成组合，因此按本次会议中的较低倾向呈现；这不等同于长期团队诊断。',
    );
  }

  const accountabilitySource = asRecord(raw.accountability);
  const accountability: Record<string, unknown> = {
    ...accountabilitySource,
    demandSignals: keepTraceable(
      asArray(accountabilitySource.demandSignals),
      'quote',
      '高要求的目标/期限/后果信号',
    ),
    standardBasisSignals: keepTraceable(
      asArray(accountabilitySource.standardBasisSignals),
      'quote',
      '高要求的标准/依据信号',
    ),
    validationSignals: keepTraceable(
      asArray(accountabilitySource.validationSignals),
      'quote',
      '高要求的验证信号',
    ),
    monitoringSignals: keepTraceable(
      asArray(accountabilitySource.monitoringSignals),
      'quote',
      '高要求的追踪/纠偏信号',
    ),
    sharedOwnershipSignals: keepTraceable(
      asArray(accountabilitySource.sharedOwnershipSignals),
      'quote',
      '责任共同拥有信号',
    ),
    closureSignals: keepTraceable(
      asArray(accountabilitySource.closureSignals),
      'quote',
      '任务闭环信号',
    ),
    counterEvidence: keepTraceable(
      asArray(accountabilitySource.counterEvidence),
      'quote',
      '高要求与问责反向证据',
    ),
  };
  const hasDemandEvidence = asArray(accountability.demandSignals).length > 0
    || asArray(accountability.standardBasisSignals).length > 0
    || asArray(accountability.validationSignals).length > 0
    || asArray(accountability.monitoringSignals).length > 0;
  if (asText(accountability.direction) === 'higher' && !hasDemandEvidence) {
    accountability.direction = 'insufficient';
    accountability.confidence = 'low';
    accountability.limitation = appendLimitation(
      accountability.limitation,
      '原有积极判断缺少可回溯的目标、标准、期限、验收、追踪或后果证据，已降为证据不足。',
    );
  }

  const standardSignals = asArray(accountability.standardBasisSignals).map(asRecord);
  const validationSignals = asArray(accountability.validationSignals).map(asRecord);
  const monitoringSignals = asArray(accountability.monitoringSignals).map(asRecord);
  const hasExplicitStandard = asText(accountability.standardStrength) === 'explicit'
    && standardSignals.some(isSubstantiveQualityStandard);
  const hasCommittedValidation = asText(accountability.validationMode) === 'committed_test'
    && asText(accountability.validationCommitment) === 'present'
    && validationSignals.some(isCommittedValidation);
  const hasCorrectionLoop = asText(accountability.monitoringMode) === 'correction_loop'
    && monitoringSignals.some(isCorrectionLoop);
  if (asText(accountability.standardStrength) === 'explicit' && !hasExplicitStandard) {
    accountability.standardStrength = standardSignals.length ? 'emerging' : 'absent';
    issues.push('声称明确的质量标准只能回溯到交付范围或形式，已降为尚在形成');
  }
  if (asText(accountability.validationMode) === 'committed_test' && !hasCommittedValidation) {
    accountability.validationMode = validationSignals.length ? 'information_request' : 'absent';
    issues.push('声称已承诺的验证只能回溯到请教或获取信息，已降为信息请求');
  }
  if (asText(accountability.monitoringMode) === 'correction_loop' && !hasCorrectionLoop) {
    accountability.monitoringMode = monitoringSignals.length ? 'check_in' : 'absent';
    issues.push('声称的纠偏回路只能回溯到普通跟进或等待回复，已降为一般跟进');
  }
  const psychologicalSafetyDirection = asText(psychologicalSafety.direction);
  if (
    asText(accountability.direction) === 'higher'
    && psychologicalSafetyDirection === 'higher'
    && !(hasExplicitStandard && (hasCommittedValidation || hasCorrectionLoop))
  ) {
    accountability.direction = 'lower';
    accountability.confidence = 'medium';
    accountability.nearHigherBoundary = asArray(accountability.demandSignals).length > 0
      || asArray(accountability.standardBasisSignals).length > 0;
    accountability.limitation = appendLimitation(
      accountability.limitation,
      '会议中可以看到期限、任务或外部期待，但尚未同时形成"可判断结果质量的明确标准"和"已承诺的验证或偏差纠正机制"。请教老师/客户、等待回复、普通分工或约定下次再看，不单独等同于学习区所需的高要求与责任承担。',
    );
  }

  const participants = normalizedParticipants.map((participant) => {
    const functionEvents = keepTraceable(
      asArray(participant.functionEvents),
      'quote',
      `${asText(participant.name) || '未命名发言者'}的互动功能`,
    );
    return {
      ...participant,
      functionEvents,
      primaryFunction: deriveTraceablePrimaryFunction(functionEvents, asText(participant.primaryFunction)),
    };
  });
  const unfinishedCandidates = keepTraceable(asArray(raw.unfinishedCandidates), 'evidence', '未完形对话');
  const disagreementCandidates = keepTraceable(asArray(raw.disagreementCandidates), 'evidence', '非共识');

  const resolveOne = (value: string) => {
    if (exactNames.has(value)) return value;
    const key = normalizeParticipantToken(value);
    return canonicalByToken.get(key) || aliases.get(key) || '';
  };
  const resolveMany = (value: string) => {
    const exact = resolveOne(value);
    if (exact) return [exact];
    const splitCandidates = [
      value.split(/[、,，;；/]+/u),
      value.split(/(?:和|与|及)/u),
    ];
    for (const parts of splitCandidates) {
      const trimmed = parts.map((part) => part.trim()).filter(Boolean);
      if (trimmed.length < 2) continue;
      const resolved = trimmed.map(resolveOne);
      if (resolved.every(Boolean)) return [...new Set(resolved)];
    }
    return [];
  };

  const normalizedInteractions: Record<string, unknown>[] = [];
  asArray(raw.semanticInteractions).map(asRecord).forEach((interaction) => {
    const rawSource = asText(interaction.source);
    const rawTarget = asText(interaction.target);
    const sources = resolveMany(rawSource);
    const targets = resolveMany(rawTarget);
    if (!sources.length || !targets.length) {
      issues.push(`语义互动姓名无法安全对齐：${rawSource || '未知'} → ${rawTarget || '未知'}`);
      return;
    }
    const evidence = asText(interaction.evidence);
    if (!evidence || !isEvidenceTraceable(evidence, parsed.raw)) {
      issues.push(`语义互动证据无法回到原文：${rawSource} → ${rawTarget}`);
      return;
    }
    sources.forEach((source) => targets.forEach((target) => {
      if (source === target) return;
      normalizedInteractions.push({ ...interaction, source, target });
    }));
  });

  return {
    evidence: {
      ...raw,
      learningProcesses,
      psychologicalSafety,
      accountability,
      participants,
      semanticInteractions: normalizedInteractions,
      unfinishedCandidates,
      disagreementCandidates,
    },
    issues: [...new Set(issues)],
  };
}

function deriveTraceablePrimaryFunction(events: Record<string, unknown>[], requested: string) {
  const validRoles = new Set(['mover', 'follower', 'opposer', 'bystander']);
  const counts = new Map<string, number>();
  events.forEach((event) => {
    const role = asText(event.function);
    if (validRoles.has(role)) counts.set(role, (counts.get(role) || 0) + 1);
  });
  if (!counts.size) return 'silent';
  const highest = Math.max(...counts.values());
  if ((counts.get(requested) || 0) === highest) return requested;
  return [...counts.entries()].find(([, count]) => count === highest)?.[0] || 'silent';
}

function appendLimitation(existing: unknown, addition: string) {
  return [asText(existing), addition].filter(Boolean).join(' ');
}

function evidenceQuoteText(signal: Record<string, unknown>) {
  return asText(signal.quote);
}

function isSubstantiveQualityStandard(signal: Record<string, unknown>) {
  const text = evidenceQuoteText(signal);
  const explicitQualityMarker = /(?:准确率|通过率|错误率|完整性|可用性|成功率|验收|达标|不少于|不低于|不得|质量标准|判断依据|优先级标准)/iu.test(text);
  if (explicitQualityMarker) return true;
  const scopeOnly = /(?:先|至少|暂时|第一步).{0,16}(?:做|搭|搞|完成|交).{0,10}(?:一个|1个)?.{0,10}(?:功能|agent|智能体|demo)/iu.test(text);
  const formatOnly = /(?:提交|交付|呈现).{0,12}(?:智能体|网页链接|录屏|demo)/iu.test(text);
  return !scopeOnly && !formatOnly;
}

function isCommittedValidation(signal: Record<string, unknown>) {
  const text = evidenceQuoteText(signal);
  return /(?:测试|试验|验证|验收|试运行|试用|样本|对照|可用性|准确率|通过率|错误率|收集.{0,8}(?:客户|用户).{0,6}反馈|(?:给|让).{0,8}(?:客户|用户).{0,8}(?:看|试|评))/iu.test(text);
}

function isCorrectionLoop(signal: Record<string, unknown>) {
  const text = evidenceQuoteText(signal);
  return /(?:偏差|纠偏|复盘|核对|检查|达不到|未达|失败|异常|错误|不通过|调整|改进|重测|重试)/u.test(text);
}

export function isEvidenceTraceable(evidence: string, transcript: string) {
  const transcriptNormalized = normalizeEvidenceText(transcript);
  if (!transcriptNormalized) return false;
  const quoted = [...evidence.matchAll(/[""]([^""]{2,})[""]/gu)].map((match) => match[1]);
  const withoutPrefix = evidence.replace(/^\s*\[[^\]]+\]\s*[:：]?\s*/u, '');
  const candidates = quoted.length ? quoted : [withoutPrefix];
  const fragments = candidates
    .flatMap((candidate) => candidate.split(/(?:…+|\.{3,})/u))
    .map(normalizeEvidenceText)
    .filter((fragment) => fragment.length >= 4);
  return fragments.length > 0 && fragments.every((fragment) => transcriptNormalized.includes(fragment));
}

function normalizeParticipantToken(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\u200b-‍\ufeff]+/gu, '');
}

function normalizeEvidenceText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\p{P}\p{S}\s]+/gu, '');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

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
