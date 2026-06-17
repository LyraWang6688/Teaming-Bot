import type { LLMInvokeOptions, LLMInvokeResult, LLMMessage, LLMProvider } from './types';

type DoubaoChatChoice = {
  message?: {
    content?: string;
  };
};

type DoubaoChatResponse = {
  choices?: DoubaoChatChoice[];
  error?: {
    message?: string;
  };
};

export class DoubaoLLMProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor() {
    this.apiKey = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || '';
    this.baseUrl = (process.env.DOUBAO_BASE_URL || process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
    this.model = process.env.DOUBAO_MODEL || process.env.ARK_MODEL || 'doubao-seed-1-8-251228';

    if (!this.apiKey) {
      throw new Error('缺少 DOUBAO_API_KEY 或 ARK_API_KEY');
    }
  }

  async invoke(messages: LLMMessage[], options: LLMInvokeOptions = {}): Promise<LLMInvokeResult> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model || this.model,
        messages,
        temperature: options.temperature ?? 1,
      }),
    });

    const data = (await response.json().catch(() => ({}))) as DoubaoChatResponse;

    if (!response.ok) {
      throw new Error(data.error?.message || `豆包 API 调用失败: HTTP ${response.status}`);
    }

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('豆包 API 返回空内容');
    }

    return { content };
  }
}
