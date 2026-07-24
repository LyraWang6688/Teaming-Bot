/**
 * 核心分析服务
 * 与输入源无关的统一处理逻辑
 */

import { createLLMProvider } from './llm';
import type { LLMProvider } from './llm/types';
import {
  TEAMING_SYSTEM_INSTRUCTION,
  ZONE_TONE,
  determineZoneFromBehaviors,
  inferZoneFromScores,
  regenerateAnalysis,
  validateBehaviorLevel,
} from '@/constants';
import { logRuntimeMonitor, toRuntimeErrorContext } from '@/lib/platform/runtimeMonitor';
import type {
  AnalysisResult,
  CommunicationParticipant,
  DialogueNetwork,
  KeyAssumption,
  LeaderAdvice,
  MeetingMetadata,
  TeamBehaviors,
  TeamState,
  UnfinishedDialogue,
  UnseenDisagreement,
} from '@/types';

interface LLMResponse {
  metadata?: MeetingMetadata;
  summary?: string;
  behaviors?: TeamBehaviors;
  teamState?: TeamState;
  keyAssumptions?: KeyAssumption[];
  unfinishedDialogues?: UnfinishedDialogue[];
  unseenDisagreements?: UnseenDisagreement[];
  leaderAdvice?: LeaderAdvice;
  communication?: CommunicationParticipant[];
  dialogueNetwork?: DialogueNetwork;
}

async function rewriteAnalysisWithLLM(
  client: LLMProvider,
  finalZone: string,
  behaviors: TeamBehaviors | undefined,
  psScore: number,
  wsScore: number,
  originalZone: string,
  meetingTranscript: string,
): Promise<string> {
  const getLevel = (behavior: { level?: string } | undefined): string => behavior?.level || 'Grey';
  const getSummary = (behavior: { summary?: string } | undefined): string => behavior?.summary || '';

  const behaviorDesc = behaviors ? [
    `直言不讳(speakingUp): ${getLevel(behaviors.speakingUp)}${getSummary(behaviors.speakingUp) ? ` — ${getSummary(behaviors.speakingUp)}` : ''}`,
    `协同(collaboration): ${getLevel(behaviors.collaboration)}${getSummary(behaviors.collaboration) ? ` — ${getSummary(behaviors.collaboration)}` : ''}`,
    `实验(experimentation): ${getLevel(behaviors.experimentation)}${getSummary(behaviors.experimentation) ? ` — ${getSummary(behaviors.experimentation)}` : ''}`,
    `反思(reflection): ${getLevel(behaviors.reflection)}${getSummary(behaviors.reflection) ? ` — ${getSummary(behaviors.reflection)}` : ''}`,
  ].join('\n') : '无行为数据';

  const zoneDescriptions: Record<string, string> = {
    Apathy: '冷漠区——低心理安全感+低工作标准，成员用最小努力完成工作，不在乎所以不说、不配合、不试、不反思',
    Comfort: '舒适区——心理安全感尚可但工作标准不足，敢说能配合但面对不确定性不试探、不批判性检视',
    Anxiety: '焦虑区——低心理安全感+高工作标准，员工不敢提出想法、不敢尝试新的程序、也不敢寻求帮助',
    Learning: '学习区——高心理安全感+高工作标准，敢说、能配合、敢试、肯想，学习闭环完整',
  };

  const rewritePrompt = `你是一位团队动力学分析专家。团队的 Zone 诊断结果需要修正，请基于修正后的 Zone 重新书写分析段落。

## 修正信息
- 原始 Zone 判断: ${originalZone}
- 修正后 Zone: ${finalZone}（${zoneDescriptions[finalZone] || finalZone}）
- 心理安全感评分: ${psScore}分 / 工作标准评分: ${wsScore}分

## 四项行为评估
${behaviorDesc}

## 会议纪要摘要（供参考引用）
${meetingTranscript.slice(0, 3000)}

## 书写要求
1. 用中文写一段流畅的分析文字（200-400字），描述团队当前所处的状态
2. 心理安全感评分和工作标准评分是你理解团队状态的透镜，不是填空模板。不要机械地先讲 PS 再讲 WS，而是从会议中最突出、最有洞察的现象切入
3. 捕捉这场会议的独特气质，不要套用固定句式
4. 当 PS/WS 的判断需要佐证时，引入四项行为的具体表现；如果叙述本身已清晰，不必凑齐四个维度
5. 禁止透露具体分数，用定性描述替代
6. 必须围绕修正后的 Zone（${finalZone}）来写，不能再出现与原始 Zone（${originalZone}）一致的基调
7. 语气专业但自然，像一位咨询师在对团队领导说话
8. 禁止出现任何关于分数计算、审计逻辑、判定规则的字眼

请直接输出分析文字，不需要任何标题、标记或额外格式。`;

  const response = await client.invoke([
    { role: 'system', content: '你是一位专业的团队动力学分析专家，擅长基于 Edmondson Teaming 框架分析团队状态。' },
    { role: 'user', content: rewritePrompt },
  ], {
    model: 'doubao-seed-2-0-pro-260215',
    temperature: 0.7,
    thinking: 'disabled',
    caching: 'disabled',
  });

  const analysis = response.content?.trim();
  if (!analysis) {
    throw new Error('LLM 返回空内容');
  }

  return analysis;
}

function getAnalysisResponseSchema(): string {
  return `{
  "metadata": {
    "meetingType": "string",
    "projectPhase": "Start-up|Post-startup",
    "totalSentences": "number",
    "effectiveSentences": "number",
    "qualityFlag": "normal|low_sample|unbalanced"
  },
  "summary": "string — 仅总结会议内容（讨论了什么议题、做了哪些决定、分配了什么任务），不涉及团队动力学分析",
  "behaviors": {
    "speakingUp": {
      "level": "Red|Blue|Green|Grey",
      "score": "number(0-10)",
      "evidence": ["string"],
      "summary": "string"
    },
    "collaboration": { ... },
    "experimentation": { ... },
    "reflection": { ... }
  },
  "teamState": {
    "zone": "Apathy|Comfort|Anxiety|Learning|Difficult to Judge",
    "psychologicalSafetyScore": "number(0-10)",
    "workStandardScore": "number(0-10)",
    "interactionFluidityScore": "number(0-10)",
    "interactionFlowBreakdown": {
      "networkStructureScore": "number(0-10)",
      "dialogueDepthScore": "number(0-10)",
      "crossTierInteractionScore": "number(0-10)"
    },
    "psychologicalSafetyBreakdown": {
      "speakingUpBehavior": "number(0-10)",
      "positiveInteraction": "number(0-10)",
      "errorTolerance": "number(0-10)"
    },
    "workStandardBreakdown": {
      "goalClarity": "number(0-10)",
      "qualityPursuit": "number(0-10)",
      "executionRigor": "number(0-10)"
    },
    "analysis": "string — 必须按【区域判断】【工作标准】【心理安全感】三段标签输出。【区域判断】120-200字：必须以'从这场会议来看，团队目前处于XX区'开头，给出区域标签+通俗解释+支撑这个判断的具体观察；【工作标准】150-250字：从工作标准维度分析，结合团队动力透镜给出深层洞察，禁止套话；【心理安全感】150-250字：从心理安全感维度分析，结合团队动力透镜给出深层洞察，禁止套话。每段禁止用'一方面/另一方面/同时/另外'等并列连词，只给一个最关键观察。"
  },
  "keyAssumptions": [
    {
      "assumption": "string — 假设本身的内容",
      "whyToVerify": "string — 为何这个假设是有待验证的"
    }
  ],
  "unfinishedDialogues": [
    {
      "topic": "string — 未完形的对话话题（具体一句话概括）",
      "whyUnfinished": "string — 为什么说它没有完形，卡在哪里，引用会议具体时刻",
      "whyNeedsClosure": "string — 为什么这里的对话需要完形，如果不补完会带来什么具体后果"
    }
  ],
  "unseenDisagreements": [
    {
      "topic": "string — 存在非共识的话题",
      "whatEachSideSays": "string — 各方不同看法分别是什么，引述关键表达",
      "whyItMatters": "string — 为什么这个非共识值得被看见。必须从价值角度写，两条禁令：(1)禁止写'不处理会出什么问题'的风险/负面角度；(2)禁止给建议、指导怎么做——不要出现'可以/应该/需要/帮助团队/把XX摊开/讨论/整合/设计出XX方案'这类 how 的表述。只纯讲 why。"
    }
  ],
  "leaderAdvice": {
    "action": "frame_for_learning|create_psychological_safety|learn_from_failure|cross_boundaries",
    "advice": "string — 3-5句话（150-250字），只给一个具体动作，必须包含可直接念出的台词，必须提到会议中具体的议题/人/事",
    "reasoning": "string — 2-4句，说透为什么选这一项行动"
  },
  "communication": [{
    "name": "string",
    "speakingShare": "number",
    "inquiryScore": "number(0-10)",
    "advocacyScore": "number(0-10)",
    "effectiveSentences": "number"
  }],
  "dialogueNetwork": {
    "nodes": [{
      "name": "string",
      "role": "string",
      "playerRole": "mover|follower|opposer|bystander|none"
    }],
    "edges": [{
      "source": "string",
      "target": "string",
      "weight": "strong|moderate|light",
      "nature": "string"
    }],
    "analysis": "string",
    "riskAssessment": "string"
  }
}`;
}

function repairJsonStrings(json: string): string {
  let result = '';
  let index = 0;
  let inString = false;

  while (index < json.length) {
    const char = json[index];

    if (!inString) {
      result += char;
      if (char === '"') {
        inString = true;
      }
      index += 1;
      continue;
    }

    if (char === '\\' && index + 1 < json.length) {
      result += char + json[index + 1];
      index += 2;
    } else if (char === '"') {
      let next = index + 1;
      while (next < json.length && /\s/.test(json[next])) {
        next += 1;
      }
      if (next < json.length && [':', ',', '}', ']'].includes(json[next])) {
        result += char;
        inString = false;
      } else {
        result += '\\"';
      }
      index += 1;
    } else if (char === '\n') {
      result += '\\n';
      index += 1;
    } else if (char === '\r') {
      result += '\\r';
      index += 1;
    } else if (char === '\t') {
      result += '\\t';
      index += 1;
    } else {
      result += char;
      index += 1;
    }
  }

  return result;
}

function generateTruncationFixes(partial: string): string[] {
  const fixes: string[] = [];

  for (let index = partial.length - 1; index >= Math.max(0, partial.length - 200); index -= 1) {
    const char = partial[index];
    if (!['}', ']', '"'].includes(char)) {
      continue;
    }

    const truncated = partial.substring(0, index + 1);
    let openCurly = 0;
    let openSquare = 0;
    let inString = false;
    let escaped = false;

    for (const current of truncated) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (current === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (current === '{') openCurly += 1;
        if (current === '}') openCurly -= 1;
        if (current === '[') openSquare += 1;
        if (current === ']') openSquare -= 1;
      }
    }

    if (inString) {
      continue;
    }

    fixes.push(
      truncated +
      ']'.repeat(Math.max(0, openSquare)) +
      '}'.repeat(Math.max(0, openCurly)),
    );

    if (fixes.length >= 10) {
      break;
    }
  }

  return fixes;
}

function parseLLMResponse(content: string): LLMResponse {
  let cleaned = content.trim();

  const codeBlockMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  const firstBraceIndex = cleaned.indexOf('{');
  if (firstBraceIndex > 0) {
    cleaned = cleaned.substring(firstBraceIndex);
  }

  const lastBraceIndex = cleaned.lastIndexOf('}');
  if (lastBraceIndex !== -1 && lastBraceIndex < cleaned.length - 1) {
    cleaned = cleaned.substring(0, lastBraceIndex + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch {}

  try {
    return JSON.parse(repairJsonStrings(cleaned));
  } catch {}

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
  }

  const embeddedJson = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (embeddedJson) {
    try {
      return JSON.parse(embeddedJson[1].trim());
    } catch {}

    const innerMatch = embeddedJson[1].match(/\{[\s\S]*\}/);
    if (innerMatch) {
      try {
        return JSON.parse(innerMatch[0]);
      } catch {}
    }
  }

  const firstBrace = cleaned.indexOf('{');
  if (firstBrace === -1) {
    throw new Error('AI返回的格式无法解析，请重新尝试');
  }

  const partial = cleaned.substring(firstBrace);

  for (const fix of generateTruncationFixes(partial)) {
    try {
      return JSON.parse(fix);
    } catch {}
  }

  let attempt = partial;
  let openCurly = 0;
  let openSquare = 0;
  let inString = false;
  let escaped = false;

  for (const char of attempt) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') openCurly += 1;
      if (char === '}') openCurly -= 1;
      if (char === '[') openSquare += 1;
      if (char === ']') openSquare -= 1;
    }
  }

  if (inString) {
    attempt += '"';
  }
  attempt += ']'.repeat(Math.max(0, openSquare));
  attempt += '}'.repeat(Math.max(0, openCurly));

  try {
    return JSON.parse(attempt);
  } catch (error) {
    logRuntimeMonitor('error', 'analysis_service', 'llm_response_parse_failed', {
      ...toRuntimeErrorContext(error),
      contentSnippet: content.substring(0, 1000),
      contentLength: content.length,
    });
    throw new Error('AI返回的格式无法解析，请重新尝试');
  }
}

function recalculateSpeakingShare(parsed: LLMResponse, transcript: string) {
  const lines = transcript.split(/\r?\n/);
  let startLine = 0;

  for (let index = 0; index < Math.min(30, lines.length); index += 1) {
    if (/智能纪要|文字记录|关键词|发言人/.test(lines[index])) {
      startLine = index + 1;
      break;
    }
  }

  const body = lines.slice(startLine).join('\n');
  const turns: { name: string; startSec: number }[] = [];
  const knownNames = parsed.communication?.map((participant) => participant.name) || [];

  const normalizeName = (value: string) => value.replace(/\s+/g, '').toLowerCase();

  const extractCleanName = (raw: string): string => {
    let name = raw.trim();
    const deviceMatch = name.match(/说话人\s*\d+\s*用\s*@?([^的]+?)\s*的设备/);
    if (deviceMatch) {
      return deviceMatch[1].trim();
    }
    name = name.replace(/^@+/, '');
    const atIndex = name.indexOf('@');
    if (atIndex > 0) {
      return name.slice(0, atIndex).trim();
    }
    return name;
  };

  const matchSpeaker = (rawName: string): string | null => {
    const cleanName = extractCleanName(rawName);
    if (!cleanName || cleanName.length < 1) {
      return null;
    }
    if (/^\d+年|^\d+分钟|^关键词$|^文字记录$|^会议主题$|^智能纪要$|^发言人|^参会人/.test(cleanName)) {
      return null;
    }

    let matched = knownNames.find((name) => name === cleanName);
    if (matched) {
      return matched;
    }

    const normalized = normalizeName(cleanName);
    matched = knownNames.find((name) => normalizeName(name) === normalized);
    if (matched) {
      return matched;
    }

    matched = knownNames.find((name) => {
      const normalizedName = normalizeName(name);
      return normalizedName.includes(normalized) || normalized.includes(normalizedName);
    });

    return matched || null;
  };

  const hmsRegex = /@?([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9@·\s]{0,30}?)\s+(\d{1,2}):(\d{2}):(\d{2})\s*/g;
  const msLineRegex = /(?:^|\n)\s*@?([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·\s]{0,25}?)\s+(\d{1,2}):(\d{2})\s*(?:\n|$)/g;

  const collectMatches = (regex: RegExp, hasHour: boolean) => {
    let matched: RegExpExecArray | null;
    while ((matched = regex.exec(body)) !== null) {
      const rawName = matched[1];
      const startSec = hasHour
        ? parseInt(matched[2], 10) * 3600 + parseInt(matched[3], 10) * 60 + parseInt(matched[4], 10)
        : parseInt(matched[2], 10) * 60 + parseInt(matched[3], 10);

      if (startSec < 0 || startSec > 8 * 3600) {
        continue;
      }

      const speaker = matchSpeaker(rawName);
      if (!speaker) {
        continue;
      }

      const last = turns[turns.length - 1];
      if (last && last.name === speaker && startSec - last.startSec < 3) {
        continue;
      }

      turns.push({ name: speaker, startSec });
    }
  };

  collectMatches(hmsRegex, true);
  if (turns.length < 5) {
    turns.length = 0;
    collectMatches(msLineRegex, false);
  }

  turns.sort((left, right) => left.startSec - right.startSec);

  const fallbackToCharCount = () => {
    const speakerCharCount = new Map<string, number>();
    const speakerPattern = /^(?:[【\[]?)([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z·\s]{0,10}?)(?:[】\]]?)\s*[：:]\s*/;
    let currentSpeaker = '';
    let currentContent = '';

    const flush = () => {
      if (currentSpeaker && currentContent.trim()) {
        const chars = currentContent.trim().length;
        if (chars > 0) {
          speakerCharCount.set(currentSpeaker, (speakerCharCount.get(currentSpeaker) || 0) + chars);
        }
      }
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const matched = trimmed.match(speakerPattern);
      if (matched) {
        flush();
        currentSpeaker = matched[1].trim();
        currentContent = trimmed.slice(matched[0].length);
      } else if (currentSpeaker) {
        currentContent += ` ${trimmed}`;
      }
    }

    flush();

    const total = Array.from(speakerCharCount.values()).reduce((sum, value) => sum + value, 0);
    if (total <= 0 || !parsed.communication) {
      return;
    }

    parsed.communication = parsed.communication.map((participant) => {
      let chars = speakerCharCount.get(participant.name) || 0;
      if (chars === 0) {
        for (const [speaker, count] of speakerCharCount.entries()) {
          if (speaker.includes(participant.name) || participant.name.includes(speaker)) {
            chars = count;
            break;
          }
        }
      }

      return {
        ...participant,
        speakingShare: Math.round((chars / total) * 100),
      };
    });
  };

  if (parsed.communication && parsed.communication.length > 0) {
    let useTimestamp = turns.length >= 2;

    if (useTimestamp) {
      turns.sort((left, right) => left.startSec - right.startSec);
      const speakerDuration: Record<string, number> = {};
      const durations: number[] = [];

      for (let index = 0; index < turns.length; index += 1) {
        let duration = 0;
        if (index < turns.length - 1) {
          duration = turns[index + 1].startSec - turns[index].startSec;
          if (duration <= 0 || duration > 300) {
            duration = 0;
          }
        }

        if (duration > 0) {
          durations.push(duration);
          speakerDuration[turns[index].name] = (speakerDuration[turns[index].name] || 0) + duration;
        }
      }

      const medianDuration = durations.length > 0
        ? durations.sort((left, right) => left - right)[Math.floor(durations.length / 2)]
        : 8;
      const lastTurn = turns[turns.length - 1];
      speakerDuration[lastTurn.name] = (speakerDuration[lastTurn.name] || 0) + medianDuration;
      durations.push(medianDuration);

      const totalDuration = Object.values(speakerDuration).reduce((sum, value) => sum + value, 0);
      if (totalDuration > 0) {
        const allDurations: Record<string, number> = {};
        for (const name of knownNames) {
          allDurations[name] = speakerDuration[name] || 0;
        }

        const rawPercentages: Record<string, number> = {};
        for (const [name, duration] of Object.entries(allDurations)) {
          rawPercentages[name] = (duration / totalDuration) * 100;
        }

        const rounded: Record<string, number> = {};
        let sum = 0;
        let maxName = '';
        let maxValue = -1;

        for (const [name, percentage] of Object.entries(rawPercentages)) {
          const roundedValue = Math.round(percentage);
          rounded[name] = roundedValue;
          sum += roundedValue;
          if (roundedValue > maxValue) {
            maxValue = roundedValue;
            maxName = name;
          }
        }

        if (sum !== 100 && maxName) {
          rounded[maxName] += 100 - sum;
        }

        parsed.communication = parsed.communication.map((participant) => ({
          ...participant,
          speakingShare: rounded[participant.name] || 0,
        }));
      } else {
        useTimestamp = false;
      }
    }

    if (!useTimestamp) {
      fallbackToCharCount();

      const shares = parsed.communication.map((participant) => participant.speakingShare || 0);
      const shareSum = shares.reduce((sum, value) => sum + value, 0);
      if (shareSum > 0 && shareSum !== 100) {
        let maxIndex = 0;
        let maxValue = shares[0];
        for (let index = 1; index < shares.length; index += 1) {
          if (shares[index] > maxValue) {
            maxValue = shares[index];
            maxIndex = index;
          }
        }

        parsed.communication[maxIndex] = {
          ...parsed.communication[maxIndex],
          speakingShare: (parsed.communication[maxIndex].speakingShare || 0) + (100 - shareSum),
        };
      }
    }

    if (parsed.dialogueNetwork?.nodes) {
      parsed.dialogueNetwork.nodes = parsed.dialogueNetwork.nodes.map((node) => {
        const matched = parsed.communication?.find((participant) => {
          if (participant.name === node.name) return true;
          if (normalizeName(participant.name) === normalizeName(node.name)) return true;
          return participant.name.includes(node.name) || node.name.includes(participant.name);
        });

        return matched ? { ...node, speakingShare: matched.speakingShare } : node;
      });
    }
  }
}

function generateTimestamp(): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const values = Object.fromEntries(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

export async function analyzeMeetingText(meetingText: string): Promise<AnalysisResult> {
  const client = createLLMProvider();

  const messages = [
    { role: 'system' as const, content: TEAMING_SYSTEM_INSTRUCTION },
    {
      role: 'user' as const,
      content: `### 会议纪要原文 ###\n\n${meetingText}\n\n### 原文结束 ###\n\n请执行 Teaming 动力学审计。\n\n【核心审计红线】：\n1. 必须全程使用中文输出。\n2. 心理安全感（低分信号）：提问少、回避困难话题、领导主导、无反馈、不求助、伪共识、纯交易关系。\n3. 工作标准（低分信号）：结论模糊、主观决策、责任缺失、归咎他人、回避挑战、问题重复、容忍低效。\n4. 证据规则：直接引用原话必须加 [姓名]: "内容"，总结现象无需加姓名。\n5. 绝对禁止在 teamState.analysis 中出现任何关于分数、审计逻辑、扣分规则的字眼，也禁止透露心理安全感和工作标准的具体评分数字。\n\n请返回符合以下 JSON Schema 的分析结果：${getAnalysisResponseSchema()}`,
    },
  ];

  let parsed: LLMResponse | null = null;
  let lastError = '';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await client.invoke(messages, {
        model: 'doubao-seed-2-0-pro-260215',
        temperature: 1,
        thinking: 'disabled',
        caching: 'disabled',
      });

      parsed = parseLLMResponse(response.content);
      if (!parsed?.behaviors || !parsed.teamState) {
        lastError = 'Incomplete response';
        parsed = null;
        continue;
      }
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error';
      parsed = null;
      if (attempt < 2) {
        logRuntimeMonitor('warn', 'analysis_service', 'llm_invoke_retry', { attempt: attempt + 1, lastError });
      }
    }
  }

  if (!parsed?.behaviors || !parsed.teamState) {
    logRuntimeMonitor('error', 'analysis_service', 'llm_response_incomplete', { lastError });
    throw new Error('AI分析失败，请重新尝试');
  }

  if (parsed.teamState.zone !== undefined) {
    const scoreInferredZone = inferZoneFromScores(
      parsed.teamState.psychologicalSafetyScore,
      parsed.teamState.workStandardScore,
    );

    if (scoreInferredZone !== parsed.teamState.zone) {
      logRuntimeMonitor('info', 'analysis_service', 'score_zone_mismatch', {
        scoreInferredZone,
        llmReturnedZone: parsed.teamState.zone,
        psychologicalSafetyScore: parsed.teamState.psychologicalSafetyScore,
        workStandardScore: parsed.teamState.workStandardScore,
        note: '分数仅作 analysis 书写参考，Zone 由决策树从行为判定。',
      });
    }
  }

  const isStartup = parsed.metadata?.projectPhase === 'Start-up';
  const qualityFlag = parsed.metadata?.qualityFlag;
  const effectiveSentences = parsed.metadata?.effectiveSentences || 0;

  if (effectiveSentences > 0 && effectiveSentences < 10) {
    logRuntimeMonitor('warn', 'analysis_service', 'effective_sentences_too_few', {
      effectiveSentences,
      forcedZone: 'Difficult to Judge',
    });
    parsed.teamState.zone = 'Difficult to Judge';
    parsed.teamState.analysis = regenerateAnalysis(
      'Difficult to Judge',
      parsed.teamState.zone || 'Difficult to Judge',
      parsed.behaviors,
      parsed.teamState.psychologicalSafetyScore,
      parsed.teamState.workStandardScore,
    );
  } else {
    const originalZone = parsed.teamState.zone;
    const zoneFromBehavior = determineZoneFromBehaviors(parsed.behaviors, isStartup, qualityFlag);

    if (zoneFromBehavior && zoneFromBehavior !== 'Difficult to Judge') {
      if (zoneFromBehavior !== originalZone) {
        logRuntimeMonitor('warn', 'analysis_service', 'zone_overridden_by_behavior', {
          originalZone,
          zoneFromBehavior,
        });
      }

      parsed.teamState.zone = zoneFromBehavior;

      if (zoneFromBehavior !== originalZone) {
        try {
          parsed.teamState.analysis = await rewriteAnalysisWithLLM(
            client,
            zoneFromBehavior,
            parsed.behaviors,
            parsed.teamState.psychologicalSafetyScore,
            parsed.teamState.workStandardScore,
            originalZone || 'Difficult to Judge',
            meetingText,
          );
        } catch (error) {
          logRuntimeMonitor('warn', 'analysis_service', 'zone_rewrite_failed_using_template', {
            ...toRuntimeErrorContext(error),
            originalZone,
            zoneFromBehavior,
          });
          parsed.teamState.analysis = regenerateAnalysis(
            zoneFromBehavior,
            originalZone || 'Difficult to Judge',
            parsed.behaviors,
            parsed.teamState.psychologicalSafetyScore,
            parsed.teamState.workStandardScore,
          );
        }
      }
    }
  }

  recalculateSpeakingShare(parsed, meetingText);

  const behaviorValidationReport: string[] = [];
  if (parsed.teamState.zone && parsed.behaviors) {
    const tone = ZONE_TONE[parsed.teamState.zone];
    if (tone) {
      behaviorValidationReport.push(`🎯 团队基调: ${parsed.teamState.zone} (${tone.primary}) - ${tone.expectation}`);
    }

    const behaviorKeys: Array<keyof TeamBehaviors> = ['speakingUp', 'collaboration', 'experimentation', 'reflection'];
    behaviorKeys.forEach((key) => {
      const behavior = parsed?.behaviors?.[key];
      if (!behavior?.level) {
        return;
      }
      const validation = validateBehaviorLevel(parsed!.teamState!.zone, key, behavior.level);
      if (!validation.isValid) {
        logRuntimeMonitor('warn', 'analysis_service', 'behavior_level_zone_mismatch', {
          behavior: key,
          zone: parsed!.teamState!.zone,
          expectedLevels: validation.expectedLevels,
          currentLevel: validation.currentLevel,
        });
        behaviorValidationReport.push(
          `⚠️ 行为级别与Zone可能不一致 [${String(key)}]: Zone="${parsed!.teamState!.zone}" 期望 [${validation.expectedLevels.join(', ')}], 但LLM分析为 "${validation.currentLevel}"`,
        );
      } else {
        behaviorValidationReport.push(`✅ 行为级别一致 [${String(key)}]: ${behavior.level}`);
      }
    });

    logRuntimeMonitor('info', 'analysis_service', 'behavior_validation_report', {
      report: behaviorValidationReport,
    });
  }

  return {
    reportTimestamp: generateTimestamp(),
    metadata: parsed.metadata!,
    summary: parsed.summary!,
    behaviors: parsed.behaviors!,
    teamState: parsed.teamState!,
    keyAssumptions: parsed.keyAssumptions || [],
    unfinishedDialogues: parsed.unfinishedDialogues || [],
    unseenDisagreements: parsed.unseenDisagreements || [],
    leaderAdvice: parsed.leaderAdvice!,
    communication: parsed.communication || [],
    dialogueNetwork: parsed.dialogueNetwork,
  };
}
