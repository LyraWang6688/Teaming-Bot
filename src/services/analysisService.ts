/**
 * 核心分析服务
 * 与输入源无关的统一处理逻辑
 */

import { createLLMProvider } from './llm';
import type { LLMProvider } from './llm/types';
import {
  TEAMING_SYSTEM_INSTRUCTION,
  inferZoneFromScores,
  validateBehaviorLevel,
  ZONE_TONE,
  determineZoneFromBehaviors,
  regenerateAnalysis
} from '@/constants';
import type { AnalysisResult, TeamBehaviors, TeamState, MeetingMetadata, LeaderAdvice, CommunicationParticipant } from '@/types';

/**
 * LLM 返回的原始数据结构（不包含 reportTimestamp）
 */
interface LLMResponse {
  metadata?: MeetingMetadata;
  summary?: string;
  behaviors?: TeamBehaviors;
  teamState?: TeamState;
  leaderAdvice?: LeaderAdvice;
  communication?: CommunicationParticipant[];
}

/**
 * 当 Zone 被决策树修正时，调用 LLM 重写 analysis 文字（比硬模板更自然）
 * 如果 LLM 调用失败，外层会 fallback 到 regenerateAnalysis 硬模板
 */
async function rewriteAnalysisWithLLM(
  client: LLMProvider,
  finalZone: string,
  behaviors: TeamBehaviors | undefined,
  psScore: number,
  wsScore: number,
  originalZone: string,
  meetingTranscript: string
): Promise<string> {
  const getLevel = (b: { level?: string } | undefined): string => b?.level || 'Grey';
  const getSummary = (b: { summary?: string } | undefined): string => b?.summary || '';

  const behaviorDesc = behaviors ? [
    `直言不讳(speakingUp): ${getLevel(behaviors.speakingUp)}${getSummary(behaviors.speakingUp) ? ' — ' + getSummary(behaviors.speakingUp) : ''}`,
    `协同(collaboration): ${getLevel(behaviors.collaboration)}${getSummary(behaviors.collaboration) ? ' — ' + getSummary(behaviors.collaboration) : ''}`,
    `实验(experimentation): ${getLevel(behaviors.experimentation)}${getSummary(behaviors.experimentation) ? ' — ' + getSummary(behaviors.experimentation) : ''}`,
    `反思(reflection): ${getLevel(behaviors.reflection)}${getSummary(behaviors.reflection) ? ' — ' + getSummary(behaviors.reflection) : ''}`,
  ].join('\n') : '无行为数据';

  const zoneDescriptions: Record<string, string> = {
    'Apathy': '冷漠区——低心理安全感+低工作标准，成员用最小努力完成工作，不在乎所以不说、不配合、不试、不反思',
    'Comfort': '舒适区——心理安全感尚可但工作标准不足，敢说能配合但面对不确定性不试探、不批判性检视',
    'Anxiety': '焦虑区——低心理安全感+高工作标准，员工不敢提出想法、不敢尝试新的程序、也不敢寻求帮助',
    'Learning': '学习区——高心理安全感+高工作标准，敢说、能配合、敢试、肯想，学习闭环完整',
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
2. **解读视角**：心理安全感评分（${psScore}分）和工作标准评分（${wsScore}分）是你理解团队状态的透镜，不是填空模板。不要机械地"先讲PS再讲WS"，而是从会议中最突出、最有洞察的现象切入，让 PS/WS 在叙述中自然浮现
3. **个性化叙述**：捕捉这场会议的独特气质——有的沉默得令人不安，有的表面热闹但没人真正推进。不要套用固定句式
4. **行为适时引入**：当 PS/WS 的判断需要佐证时，引入四项行为的具体表现；如果叙述本身已清晰，不必凑齐四个维度
5. **禁止透露具体分数**：analysis 中不得出现心理安全感或工作标准的具体评分数字，用定性描述替代（如"心理安全感明显不足"而非"心理安全感仅${psScore}分"）
6. 必须围绕修正后的 Zone（${finalZone}）来写，不能再出现与原始 Zone（${originalZone}）一致的基调
7. 语气专业但自然，像一位咨询师在对团队领导说话
8. **绝对禁止**出现任何关于分数计算、审计逻辑、判定规则的字眼

请直接输出分析文字，不需要任何标题、标记或额外格式。`;

  const messages = [
    { role: 'system' as const, content: '你是一位专业的团队动力学分析专家，擅长基于 Edmondson Teaming 框架分析团队状态。' },
    { role: 'user' as const, content: rewritePrompt }
  ];

  const response = await client.invoke(messages, {
    model: 'doubao-seed-1-8-251228',
    temperature: 0.7,
    thinking: 'disabled',
    caching: 'disabled'
  });

  const analysis = response.content?.trim();
  if (!analysis) {
    throw new Error('LLM 返回空内容');
  }
  return analysis;
}

/**
 * 获取分析响应的 JSON Schema 说明
 */
function getAnalysisResponseSchema(): string {
  return `{
  "metadata": {
    "meetingType": "string",
    "projectPhase": "Start-up|Post-startup",
    "totalSentences": "number",
    "effectiveSentences": "number",
    "qualityFlag": "normal|low_sample|unbalanced"
  },
  "summary": "string",
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
    "analysis": "string"
  },
  "leaderAdvice": {
    "action": "frame_for_learning|create_psychological_safety|learn_from_failure|cross_boundaries",
    "advice": "string",
    "reasoning": "string"
  },
  "communication": [{
    "name": "string",
    "speakingShare": "number",
    "inquiryScore": "number(0-10)",
    "advocacyScore": "number(0-10)",
    "effectiveSentences": "number"
  }]
}`;
}

/**
 * 尝试修复 JSON 字符串中的常见问题
 */
function repairJSON(jsonStr: string): string {
  let repaired = jsonStr;
  
  // 修复字符串值内部的控制字符（换行符、制表符等）
  // 策略：找到所有字符串值（冒号后面的引号内容），转义其中的控制字符
  repaired = repaired.replace(
    /"([^"]*(?:\\.[^"]*)*)"/g,
    (_match, content) => {
      // 转义字符串内部的控制字符
      const fixed = content
        .replace(/\n/g, '\\n')   // 换行符
        .replace(/\r/g, '\\r')   // 回车符
        .replace(/\t/g, '\\t')   // 制表符
        .replace(/\f/g, '\\f')   // 换页符
        .replace(/\x00/g, '\\u0000'); // 空字符
      return `"${fixed}"`;
    }
  );
  
  // 尝试找到并修复未闭合的 JSON
  // 计算括号数量
  const openBraces = (repaired.match(/\{/g) || []).length;
  const closeBraces = (repaired.match(/\}/g) || []).length;
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;
  
  // 补全缺失的闭合括号
  const missingBraces = openBraces - closeBraces;
  const missingBrackets = openBrackets - closeBrackets;
  
  if (missingBraces > 0) {
    repaired += '}'.repeat(missingBraces);
  }
  if (missingBrackets > 0) {
    repaired += ']'.repeat(missingBrackets);
  }
  
  return repaired;
}

/**
 * 解析 LLM 响应，提取 JSON 数据
 */
function parseLLMResponse(content: string): LLMResponse {
  try {
    // 尝试直接解析 JSON
    return JSON.parse(content);
  } catch {
    // 如果直接解析失败，尝试提取 JSON 部分
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // 尝试修复 JSON
        console.error('Failed to parse extracted JSON, attempting repair...');
        try {
          const repaired = repairJSON(jsonMatch[0]);
          return JSON.parse(repaired);
        } catch (repairError) {
          console.error('Failed to repair JSON:', repairError);
          console.error('Content snippet:', content.substring(0, 500));
        }
      }
    }

    // 如果仍然失败，抛出错误
    console.error('Failed to parse LLM response completely');
    console.error('Full content:', content);
    throw new Error('AI返回的格式无法解析，请重新尝试');
  }
}

/**
 * 生成报告时间戳
 */
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
  const parts = formatter.formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  ) as Record<string, string>;

  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

/**
 * 核心分析函数
 * 输入：会议纪要文本
 * 输出：完整的分析结果
 */
export async function analyzeMeetingText(meetingText: string): Promise<AnalysisResult> {
  const client = createLLMProvider();

  // 构建 LLM 消息
  const messages = [
    { role: 'system' as const, content: TEAMING_SYSTEM_INSTRUCTION },
    {
      role: 'user' as const,
      content: `### 会议纪要原文 ###\n\n${meetingText}\n\n### 原文结束 ###\n\n请执行 Teaming 动力学审计。\n\n【核心审计红线】：\n1. 必须全程使用中文输出。\n2. 心理安全感（低分信号）：提问少、回避困难话题、领导主导、无反馈、不求助、伪共识、纯交易关系。\n3. 工作标准（低分信号）：结论模糊、主观决策、责任缺失、归咎他人、回避挑战、问题重复、容忍低效。\n4. 证据规则：直接引用原话必须加 [姓名]: "内容"，总结现象无需加姓名。\n5. **绝对禁止**在 teamState.analysis 中出现任何关于分数、审计逻辑、扣分规则的字眼，也**禁止透露心理安全感和工作标准的具体评分数字**。请用定性描述（如"心理安全感明显不足"）替代具体数字。\n\n请返回符合以下 JSON Schema 的分析结果：${getAnalysisResponseSchema()}`
    }
  ];

  // 使用豆包模型进行分析
  const response = await client.invoke(messages, {
    model: 'doubao-seed-1-8-251228',
    temperature: 1,
    thinking: 'disabled',
    caching: 'disabled'
  });

  // 解析响应
  const parsed = parseLLMResponse(response.content);

  // 验证响应的完整性
  if (!parsed || !parsed.behaviors || !parsed.teamState) {
    console.error('Incomplete LLM response:', parsed);
    throw new Error('AI返回的分析结果不完整，请重新尝试');
  }

  // ========================================
  // Zone 判定逻辑（决策树，分数仅作 analysis 书写参考）
  // ========================================
  // 原则：Zone 完全由决策树从行为色标判定，分数不参与判定
  // 分数角色：作为 analysis 的解读视角（PS/WS 为透镜，行为为佐证），禁止在文字中透露具体分数
  // 执行顺序：
  //   1. 记录分数推断方向与行为判定方向的差异（仅日志，不修正 Zone）
  //   2. 用决策树从行为色标判定 Zone → 最终 Zone
  //   3. 验证行为级别与 Zone 一致性（仅警告，不修正）
  // ========================================

  // 步骤1：记录分数推断方向与行为判定的差异（仅日志参考，不修正 Zone）
  if (parsed.teamState && parsed.teamState.zone !== undefined) {
    const scoreInferredZone = inferZoneFromScores(
      parsed.teamState.psychologicalSafetyScore,
      parsed.teamState.workStandardScore
    );

    if (scoreInferredZone !== parsed.teamState.zone) {
      console.info(
        `📊 [参考] 分数指向 "${scoreInferredZone}"，LLM返回 "${parsed.teamState.zone}" ` +
        `(PS=${parsed.teamState.psychologicalSafetyScore}, WS=${parsed.teamState.workStandardScore}) ` +
        `→ 分数仅作 analysis 书写参考，Zone 由决策树从行为判定`
      );
    }
  }

  // 步骤2：以决策树从行为色标判定最终 Zone
  const isStartup = parsed.metadata?.projectPhase === 'Start-up';
  const qualityFlag = parsed.metadata?.qualityFlag;

  // 修复4：有效发言过少时强制返回 Difficult to Judge
  const effectiveSentences = parsed.metadata?.effectiveSentences || 0;
  if (effectiveSentences > 0 && effectiveSentences < 10) {
    console.warn(
      `⚠️ 有效发言不足10句(${effectiveSentences}句)，强制返回 Difficult to Judge`
    );
    parsed.teamState.zone = 'Difficult to Judge';
    parsed.teamState.analysis = regenerateAnalysis(
      'Difficult to Judge',
      parsed.teamState?.zone || 'Difficult to Judge',
      parsed.behaviors,
      parsed.teamState.psychologicalSafetyScore,
      parsed.teamState.workStandardScore
    );
  } else {
    const zoneFromBehavior = determineZoneFromBehaviors(parsed.behaviors, isStartup, qualityFlag);
    if (zoneFromBehavior && zoneFromBehavior !== 'Difficult to Judge') {
      const originalZone = parsed.teamState?.zone;
      if (zoneFromBehavior !== originalZone) {
        console.warn(
          `🎯 [最终] Zone 由 Behavior 决定: LLM返回="${originalZone}", ` +
          `Behavior 分析指向="${zoneFromBehavior}" → 以 Behavior 为准`
        );
      }
      parsed.teamState.zone = zoneFromBehavior;

      // 如果 Zone 被修正，用 LLM 重写 analysis（更自然），硬模板作为兜底
      if (zoneFromBehavior !== originalZone) {
        console.log(`📝 Zone 修正: ${originalZone} → ${zoneFromBehavior}，尝试 LLM 重写 analysis`);
        try {
          const rewrittenAnalysis = await rewriteAnalysisWithLLM(
            client,
            zoneFromBehavior,
            parsed.behaviors,
            parsed.teamState.psychologicalSafetyScore,
            parsed.teamState.workStandardScore,
            originalZone || 'Difficult to Judge',
            meetingText
          );
          parsed.teamState.analysis = rewrittenAnalysis;
          console.log(`✅ LLM 重写 analysis 成功`);
        } catch (err) {
          console.warn(`⚠️ LLM 重写 analysis 失败，使用硬模板兜底:`, err);
          parsed.teamState.analysis = regenerateAnalysis(
            zoneFromBehavior,
            originalZone || 'Difficult to Judge',
            parsed.behaviors,
            parsed.teamState.psychologicalSafetyScore,
            parsed.teamState.workStandardScore
          );
        }
      }
    }
  }

  // 检查行为级别与zone的一致性（确保报告基调统一）
  const behaviorValidationReport: string[] = [];
  if (parsed.teamState?.zone && parsed.behaviors) {
    const zone = parsed.teamState.zone;
    const tone = ZONE_TONE[zone as keyof typeof ZONE_TONE];

    if (tone) {
      behaviorValidationReport.push(`🎯 团队基调: ${zone} (${tone.primary}) - ${tone.expectation}`);
    }

    // 检查每个行为级别
    const behaviorKeys: Array<keyof TeamBehaviors> = [
      'speakingUp',
      'collaboration',
      'experimentation',
      'reflection'
    ];

    behaviorKeys.forEach(key => {
      const behavior = parsed.behaviors?.[key];
      if (behavior?.level) {
        const validation = validateBehaviorLevel(zone, key, behavior.level);

        if (!validation.isValid) {
          const warning = `⚠️ 行为级别与Zone可能不一致 [${String(key)}]: ` +
            `Zone="${zone}" 期望 [${validation.expectedLevels.join(', ')}], ` +
            `但LLM分析为 "${validation.currentLevel}"`;
          console.warn(warning);
          behaviorValidationReport.push(warning);
        } else {
          behaviorValidationReport.push(`✅ 行为级别一致 [${String(key)}]: ${behavior.level}`);
        }
      }
    });

    // 输出一致性报告到日志
    console.log('\n=== 一致性检查报告 ===');
    behaviorValidationReport.forEach(line => console.log(line));
    console.log('======================\n');
  }

  // 添加报告时间戳
  const reportTimestamp = generateTimestamp();

  return {
    reportTimestamp,
    metadata: parsed.metadata!,
    summary: parsed.summary!,
    behaviors: parsed.behaviors!,
    teamState: parsed.teamState!,
    leaderAdvice: parsed.leaderAdvice!,
    communication: parsed.communication || []
  } as AnalysisResult;
}
