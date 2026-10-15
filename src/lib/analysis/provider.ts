export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface InvokeOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  label?: string;
  thinking?: 'enabled' | 'disabled';
  jsonRetries?: number;
  requestRetries?: number;
}

interface ProviderResponse {
  content: string;
  finishReason?: string | null;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  constraintsApplied: {
    jsonObject: boolean;
    maxTokens: boolean;
  };
}

export class ModelRequestError extends Error {
  retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = 'ModelRequestError';
    this.retryable = retryable;
  }
}

/**
 * 环境变量兼容读取：优先 LLM_*，回退到 DOUBAO_* 和 ARK_*。
 * 避免要求用户在服务器配置新的环境变量。
 */
/**
 * 分析凭证与模型的读取顺序。
 *
 * 前缀从新到旧：`LLM_*`（中性，推荐）→ `DOUBAO_*`（历史命名）→ `ARK_*`（更早的命名）。
 * 保留这个顺序是为了让**换模型时只用加一组新变量、不动代码**：
 * 例如切到 DeepSeek，只需配 `LLM_API_KEY` / `LLM_BASE_URL` / `ANALYSIS_MODEL`，
 * 它们优先级最高，会盖过旧的 `DOUBAO_*`。
 *
 * 注意：`ANALYSIS_PROVIDER` 是**死变量** —— 代码里从未读过它，改它不会换模型。
 */
function getApiKey(): string | undefined {
  return process.env.LLM_API_KEY || process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY;
}

function getBaseUrl(): string | undefined {
  return process.env.LLM_BASE_URL || process.env.DOUBAO_BASE_URL || process.env.ARK_BASE_URL;
}

/**
 * 取分析模型名。
 *
 * 这里**故意不设默认值**。此前兜底写死成 `'doubao-seed-2-0-pro-260215'`——一个带日期后缀
 * 的豆包接入点。这类接入点会过期，而"静默回退到一个失效模型"的表现为**分析失败**，
 * 排查时会先怀疑提示词、逐字稿、网络、额度，很久之后才会想到是模型名过期了。
 * 与其猜一个可能失效的名字，不如在缺配置时直接说清楚缺什么。
 */
function getModel(): string {
  const model = process.env.ANALYSIS_MODEL || process.env.DOUBAO_MODEL || process.env.ARK_MODEL;
  if (!model) {
    throw new Error(
      '未配置分析模型：请设置 ANALYSIS_MODEL（推荐）或 DOUBAO_MODEL。' +
        '本服务不再提供硬编码的兜底模型名——接入点会过期，静默回退比直接报错更难排查。',
    );
  }
  return model;
}

export function getProviderStatus() {
  const configured = isExternalProvider();
  return {
    configured,
    provider: 'external',
    model: getModel(),
    structuredJson: configured,
    outputTokenLimit: configured,
  };
}

function isExternalProvider() {
  return Boolean(getApiKey() && getBaseUrl());
}

function getProviderName() {
  return 'external';
}

export async function invokeJson(messages: ChatMessage[], options?: InvokeOptions) {
  const timeoutMs = options?.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS || 480000);
  const label = options?.label || '模型分析';
  const jsonRetries = Math.max(0, options?.jsonRetries ?? 1);
  const requestRetries = Math.max(0, options?.requestRetries ?? 2);
  const model = getModel();
  const provider = getProviderName();
  let lastError: unknown = null;

  for (let jsonAttempt = 0; jsonAttempt <= jsonRetries; jsonAttempt += 1) {
    const attemptMessages: ChatMessage[] = jsonAttempt === 0
      ? messages
      : [
          ...messages,
          {
            role: 'user',
            content: '上一次输出没有形成可用的完整 JSON。请重新生成整份结果，只输出一个完整 JSON object；不要省略必需字段，并检查数组元素之间的逗号、引号和括号是否闭合。',
          },
        ];
    const requestedMaxTokens = expandedTokenLimit(options?.maxTokens, jsonAttempt);

    for (let requestAttempt = 0; requestAttempt <= requestRetries; requestAttempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await withTimeout(
          invokeProvider(attemptMessages, {
            model,
            temperature: options?.temperature ?? 0.25,
            thinking: options?.thinking ?? 'disabled',
            maxTokens: requestedMaxTokens,
            timeoutMs,
            jsonObject: true,
          }),
          timeoutMs,
          `${label}超过 ${Math.round(timeoutMs / 60000)} 分钟，已停止本次请求。`,
        );
        const baseLog = {
          provider,
          label,
          model,
          jsonAttempt: jsonAttempt + 1,
          requestAttempt: requestAttempt + 1,
          elapsedMs: Date.now() - startedAt,
          contentLength: response.content.length,
          finishReason: response.finishReason,
          usage: response.usage,
          requestedMaxTokens,
          constraintsApplied: response.constraintsApplied,
        };
        try {
          const parsed = parseJsonObject(response.content || '');
          console.info('[LLM]', { ...baseLog, jsonResolution: 'direct_or_local_repair' });
          return parsed;
        } catch (parseError) {
          lastError = parseError;
          console.warn('[LLM JSON]', {
            ...baseLog,
            parseError: sanitizeProviderMessage(parseError instanceof Error ? parseError.message : String(parseError)),
          });

          if (response.finishReason !== 'length') {
            try {
              const repaired = await repairJsonWithModel(response.content, {
                model,
                timeoutMs,
                maxTokens: requestedMaxTokens,
                label,
              });
              console.info('[LLM JSON]', {
                provider,
                label,
                model,
                jsonAttempt: jsonAttempt + 1,
                requestAttempt: requestAttempt + 1,
                jsonResolution: 'syntax_only_model_repair',
              });
              return repaired;
            } catch (repairError) {
              lastError = repairError;
              console.warn('[LLM JSON repair]', {
                provider,
                label,
                model,
                error: sanitizeProviderMessage(repairError instanceof Error ? repairError.message : String(repairError)),
              });
            }
          }
          break;
        }
      } catch (error) {
        lastError = error;
        if (requestAttempt >= requestRetries) break;
        await wait([5_000, 15_000, 30_000][Math.min(requestAttempt, 2)]);
      }
    }
  }

  const message = lastError instanceof Error ? sanitizeProviderMessage(lastError.message) : '未知原因';
  throw new Error(`${label}未能生成完整 JSON，已完成局部修复与自动重试：${message}`);
}

async function invokeProvider(
  messages: ChatMessage[],
  options: {
    model: string;
    temperature: number;
    thinking: 'enabled' | 'disabled';
    maxTokens?: number;
    timeoutMs: number;
    jsonObject: boolean;
  },
): Promise<ProviderResponse> {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  if (!apiKey || !baseUrl) {
    throw new ModelRequestError(
      '未配置 LLM_API_KEY/LLM_BASE_URL（或 DOUBAO_API_KEY/DOUBAO_BASE_URL）。请在环境变量中配置外部大模型端点后再发起分析。',
      false,
    );
  }
  const body = {
    model: options.model,
    messages,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    response_format: options.jsonObject ? { type: 'json_object' as const } : undefined,
    thinking: { type: options.thinking },
  };
  const endpoint = `${baseUrl.replace(/\/$/u, '')}/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const payload = await response.text();
  if (!response.ok) {
    throw new ModelRequestError(
      `模型接口返回 HTTP ${response.status}：${sanitizeProviderMessage(payload)}`,
      response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
    );
  }
  let completion: ArkChatCompletion;
  try {
    completion = JSON.parse(payload) as ArkChatCompletion;
  } catch {
    throw new ModelRequestError('模型接口返回了无法解析的响应。');
  }
  const choice = completion.choices[0];
  return {
    content: choice?.message?.content || '',
    finishReason: choice?.finish_reason,
    usage: completion.usage ? {
      promptTokens: completion.usage.prompt_tokens,
      completionTokens: completion.usage.completion_tokens,
      totalTokens: completion.usage.total_tokens,
    } : undefined,
    constraintsApplied: { jsonObject: true, maxTokens: Boolean(options.maxTokens) },
  };
}

interface ArkChatCompletion {
  choices: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

async function repairJsonWithModel(
  malformed: string,
  options: { model: string; timeoutMs: number; maxTokens?: number; label: string },
) {
  if (!malformed.trim()) throw new Error('模型返回为空，无法进行 JSON 局部修复。');
  const repairMessages: ChatMessage[] = [
    {
      role: 'system',
      content: '你是 JSON 语法修复器。只修复逗号、引号、转义与括号等语法错误；不得概括、改写、增删事实或重做分析。只输出一个 JSON object。',
    },
    {
      role: 'user',
      content: `修复下面的 JSON。保留所有字段和值；若原文已经在结尾完整闭合，不得增加新字段。\n\n${malformed}`,
    },
  ];
  const response = await withTimeout(
    invokeProvider(repairMessages, {
      model: options.model,
      temperature: 0,
      thinking: 'disabled',
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
      jsonObject: true,
    }),
    options.timeoutMs,
    `${options.label}的 JSON 局部修复超时。`,
  );
  return parseJsonObject(response.content);
}

function expandedTokenLimit(maxTokens: number | undefined, jsonAttempt: number) {
  if (!maxTokens || jsonAttempt === 0) return maxTokens;
  return Math.min(Math.ceil(maxTokens * 1.35), 12_000);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new ModelRequestError(message)), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

function sanitizeProviderMessage(message = '') {
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/ark-[A-Za-z0-9-]+/g, 'ark-[已隐藏]')
    .slice(0, 240);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseJsonObject(input: string): Record<string, unknown> {
  const cleaned = input.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const candidates = [cleaned];
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  let lastError: unknown = null;
  for (const candidate of [...new Set(candidates)]) {
    for (const variant of localJsonRepairs(candidate)) {
      try {
        const value = JSON.parse(variant);
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('模型未返回可解析的 JSON。');
}

function localJsonRepairs(input: string) {
  const withoutTrailingCommas = input.replace(/,\s*([}\]])/g, '$1');
  return [...new Set([
    input,
    withoutTrailingCommas,
    repairMissingJsonCommas(input),
    repairMissingJsonCommas(withoutTrailingCommas),
  ])];
}

function repairMissingJsonCommas(input: string) {
  let repaired = input;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      JSON.parse(repaired);
      return repaired;
    } catch (error) {
      if (!(error instanceof SyntaxError)) return repaired;
      const message = error.message;
      const isMissingSeparator = message.includes("Expected ',' or ']'")
        || message.includes("Expected ',' or '}'");
      const positionMatch = message.match(/position\s+(\d+)/i);
      if (!isMissingSeparator || !positionMatch) return repaired;
      const position = Number(positionMatch[1]);
      if (!Number.isFinite(position) || position <= 0 || position >= repaired.length) return repaired;
      repaired = `${repaired.slice(0, position)},${repaired.slice(position)}`;
    }
  }
  return repaired;
}
