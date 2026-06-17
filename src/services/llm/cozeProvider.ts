import { Config, LLMClient } from 'coze-coding-dev-sdk';
import type { LLMInvokeOptions, LLMInvokeResult, LLMMessage, LLMProvider } from './types';

export class CozeLLMProvider implements LLMProvider {
  private readonly client: LLMClient;

  constructor() {
    this.client = new LLMClient(new Config());
  }

  async invoke(messages: LLMMessage[], options: LLMInvokeOptions = {}): Promise<LLMInvokeResult> {
    const response = await this.client.invoke(messages, {
      model: options.model || process.env.COZE_MODEL || 'doubao-seed-1-8-251228',
      temperature: options.temperature,
      thinking: options.thinking,
      caching: options.caching,
    });

    return { content: response.content || '' };
  }
}
