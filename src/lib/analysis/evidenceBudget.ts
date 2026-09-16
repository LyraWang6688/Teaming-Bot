/**
 * 证据提取输出预算自适应选择
 *
 * 根据证据提取阶段输入的估算 token 数，选择合适的 max_tokens 预算。
 * 目标：避免长会议第一次在固定 6000 token 处被截断后整体重试，
 * 同时保持短会议的低预算行为不变。
 *
 * 估算方法：纯字符数估算，不调用模型，不引入 tokenizer 依赖。
 * - 中文为主文本按 1.7 chars/token 估算
 * - 基础固定开销（系统提示词 + 用户指令模板 + deterministic facts）约 6300 chars ≈ 3000 tokens
 */

export interface BudgetSelection {
  /** 估算的证据提取 prompt token 数（仅用于分档，非精确值） */
  estimatedPromptTokens: number;
  /** 预算档位：'standard' 或 'extended' */
  tier: 'standard' | 'extended';
  /** 选择的 max_tokens 值 */
  maxTokens: number;
}

/** 短会议标准预算（与历史行为一致） */
export const STANDARD_EVIDENCE_MAX_TOKENS = 6000;

/** 长会议扩展预算（覆盖两份已知长会议的 6670–6720 completion tokens 需求，留一定余量） */
export const EXTENDED_EVIDENCE_MAX_TOKENS = 8500;

/**
 * 分档阈值（estimatedPromptTokens >= 此值时使用扩展预算）。
 * 选择 20000：
 * - 昂儒 promptTokens = 4324 → <20000 → 6000（标准档，行为不变）
 * - 筹备组 promptTokens = 29517 → >=20000 → 8500（扩展档）
 * - ABC捐赠圈 promptTokens = 37035 → >=20000 → 8500（扩展档）
 */
export const EXTENDED_BUDGET_THRESHOLD_TOKENS = 20000;

/**
 * 基础固定开销 token 估算（系统提示词 + 用户指令模板 + 发言者统计 facts）。
 * 基于实际测量：EVIDENCE_SYSTEM_PROMPT 2810 chars + buildEvidenceRequest 模板 3101 chars
 * + 典型 3–4 位发言者 facts 约 400 chars = 约 6300 chars。
 * 按中英混合 2.1 chars/token 保守估算 ≈ 3000 tokens。
 */
export const BASE_PROMPT_ESTIMATED_TOKENS = 3000;

/**
 * 中文为主文本的字符到 token 换算系数。
 * 纯中文约 1.7 chars/token，含标点、数字、英文专有名词时略高。
 * 取 1.8 作为偏保守的估算（宁可高估一点进扩展档，避免截断重试的大浪费）。
 */
export const CHARS_PER_TOKEN = 1.8;

/**
 * 根据会议转写文本字符数估算证据提取 prompt 的 token 数。
 * 纯估算，不调用模型。
 */
export function estimateEvidencePromptTokens(transcriptChars: number): number {
  if (transcriptChars <= 0) return BASE_PROMPT_ESTIMATED_TOKENS;
  const transcriptTokens = Math.ceil(transcriptChars / CHARS_PER_TOKEN);
  return BASE_PROMPT_ESTIMATED_TOKENS + transcriptTokens;
}

/**
 * 根据估算的 prompt token 数选择证据提取的输出预算。
 */
export function selectEvidenceOutputBudget(estimatedPromptTokens: number): BudgetSelection {
  if (estimatedPromptTokens >= EXTENDED_BUDGET_THRESHOLD_TOKENS) {
    return {
      estimatedPromptTokens,
      tier: 'extended',
      maxTokens: EXTENDED_EVIDENCE_MAX_TOKENS,
    };
  }
  return {
    estimatedPromptTokens,
    tier: 'standard',
    maxTokens: STANDARD_EVIDENCE_MAX_TOKENS,
  };
}
