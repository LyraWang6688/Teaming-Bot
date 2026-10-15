/**
 * ABC 相关性甄别（Gate）
 *
 * ## 为什么需要它
 *
 * 用户的豆包账号会开**很多种会**：需求会、产品迭代会、内部协同会、技术讨论、闲聊……
 * 而本产品**只服务于「ABC 向善公益实战营」相关的内容**（帮公益机构做提效 / 转型 /
 * 数字化的讨论）。
 *
 * 过去靠「会议名里写 ABC」区分，不可靠：名字不写 ABC 的会也可能完全相关；
 * 名字写了的也可能是无关的行政会。所以改为**让模型看内容判断**。
 *
 * ## 放在哪一层
 *
 * 放在**引擎层**，加一个可选开关：
 *
 *   analyzeTranscript(raw, { abcGate: true })    ← 宿主通道 / HTTP 接口启用
 *   analyzeTranscript(raw)                        ← 网页版现状，行为一字不变
 *
 * 这样三条路（MCP / HTTP / Skill）自动都有甄别，而且只有一份实现，不会漂移。
 *
 * ## 误判方向
 *
 * **宁可放宽。**
 * - 假阴性（该分析却被跳过）更糟——用户拿不到他期待的报告
 * - 假阳性（不该分析却分析了）只是多花一点额度
 *
 * 所以判据里写了「只要讨论对象疑似公益机构 / 其数字化提效转型，就算相关」，
 * 并把 confidence 一起返回，供事后复核。
 */
import { invokeJson, type ChatMessage } from './provider';

export type AbcGateResult = {
  /** 是否与 ABC 向善公益实战营相关 */
  related: boolean;
  confidence: 'high' | 'medium' | 'low';
  /** 一句话说明判断依据（会写进日志，供事后查"为什么这场没分析"） */
  reason: string;
  /** 命中的特征信号，便于人工复核时快速定位 */
  matchedSignals: string[];
};

/** 逐字稿不合格到无法判断时抛出（例如内容为空） */
export class AbcGateError extends Error {
  readonly code = 'not_abc_related';
  constructor(
    message: string,
    readonly result: AbcGateResult,
  ) {
    super(message);
    this.name = 'AbcGateError';
  }
}

const SYSTEM_PROMPT = `你是会议内容分类器。判断一段会议逐字稿是否与「ABC 向善公益实战营」相关。

【什么算相关】
这场会在讨论或推进以下任一类事情，就算相关：
- 公益机构 / 社会组织 / 基金会 / 公益项目的**数字化、系统化、提效、转型**
- 为某个公益组织**搭建或改进系统、工具、流程、方案**
- 提到 ABC、向善、实战营、训练营、公益营
- 公益场景下的需求梳理、产品设计、实施落地、复盘

【什么算不相关】
- 纯商业公司内部事务（人事、财务、行政、考勤）
- 与公益无关的产品 / 技术讨论（纯架构、纯排障、纯工具选型）
- 私人闲聊、测试录音、语音识别误入的内容

【判断原则】
- **宁可放宽**：只要讨论对象疑似公益机构、或其数字化提效转型，就判 related=true。
  漏掉一场该分析的会，比多分析一场代价更大。
- **看内容，不看会议名**：会议名里有没有 ABC 不影响你的判断。
- 逐字稿含大量识别噪声（背景音、错别字）时，抓主线判断，不要因为噪声就判不相关。

【输出】
只输出一个 JSON 对象，不要任何其它文字：
{
  "related": true 或 false,
  "confidence": "high" | "medium" | "low",
  "reason": "一句话说明判断依据（中文，40 字以内）",
  "matchedSignals": ["命中的特征词或片段", "..."]
}`;

/**
 * 只取逐字稿的一段作为判据，控制成本。
 *
 * 判断"这场会在谈什么"不需要全文：开头几轮往往就把议题交代清楚了。
 * 但有些会先寒暄再入正题，所以取**开头 + 中段 + 结尾**三段拼接，
 * 比只取开头更稳，成本仍远低于整篇。
 */
function buildExcerpt(raw: string, perSlice = 2500): string {
  const text = raw.trim();
  if (text.length <= perSlice * 3) return text;
  const head = text.slice(0, perSlice);
  const midStart = Math.floor(text.length / 2 - perSlice / 2);
  const middle = text.slice(midStart, midStart + perSlice);
  const tail = text.slice(-perSlice);
  return [
    '【开头】',
    head,
    '【中段】',
    middle,
    '【结尾】',
    tail,
  ].join('\n');
}

function normalizeResult(parsed: Record<string, unknown>): AbcGateResult {
  const related = parsed.related === true;
  const confidenceRaw = String(parsed.confidence ?? '').toLowerCase();
  const confidence: AbcGateResult['confidence'] =
    confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
      ? confidenceRaw
      : 'low';
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 200) : '';
  const signals = Array.isArray(parsed.matchedSignals)
    ? parsed.matchedSignals
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 8)
    : [];
  return { related, confidence, reason, matchedSignals: signals };
}

/**
 * 判断这场会是不是 ABC 相关。
 *
 * 调用失败时**不阻断分析**——甄别是过滤器，不是安全边界，
 * 模型偶发异常不该让用户拿不到报告。失败时返回 related=true 并标 low confidence，
 * 同时把失败原因写进 reason，供事后复核。
 */
export async function evaluateAbcRelevance(rawTranscript: string): Promise<AbcGateResult> {
  const excerpt = buildExcerpt(rawTranscript);
  if (excerpt.length < 30) {
    return {
      related: false,
      confidence: 'high',
      reason: '内容过短，无法判断是否与 ABC 相关',
      matchedSignals: [],
    };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `以下是会议逐字稿：\n\n${excerpt}` },
  ];

  try {
    // invokeJson 直接返回解析好的 JSON 对象（内部已做 JSON 修复与重试）
    const parsed = await invokeJson(messages, {
      label: 'ABC 相关性甄别',
      timeoutMs: Number(process.env.ABC_GATE_TIMEOUT_MS || 60000),
      jsonRetries: 1,
      requestRetries: 1,
      maxTokens: 400,
    });
    return normalizeResult(parsed as Record<string, unknown>);
  } catch (error) {
    // 甄别本身失败 → 放行（宁可多分析一场，也不要因为分类器抽风而漏报）
    return {
      related: true,
      confidence: 'low',
      reason: `甄别调用失败，已放行以免漏报：${String((error as Error)?.message || error).slice(0, 120)}`,
      matchedSignals: [],
    };
  }
}
