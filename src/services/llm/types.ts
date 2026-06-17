export type LLMMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LLMInvokeOptions = {
  model?: string;
  temperature?: number;
  thinking?: 'enabled' | 'disabled';
  caching?: 'enabled' | 'disabled';
};

export type LLMInvokeResult = {
  content: string;
};

export interface LLMProvider {
  invoke(messages: LLMMessage[], options?: LLMInvokeOptions): Promise<LLMInvokeResult>;
}
