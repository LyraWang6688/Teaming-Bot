import { CozeLLMProvider } from './cozeProvider';
import { DoubaoLLMProvider } from './doubaoProvider';
import type { LLMProvider } from './types';

export type AnalysisProviderName = 'coze' | 'doubao';

export function getAnalysisProviderName(): AnalysisProviderName {
  const provider = (process.env.ANALYSIS_PROVIDER || 'coze').toLowerCase();

  if (provider === 'doubao') return 'doubao';
  if (provider === 'coze') return 'coze';

  throw new Error(`不支持的 ANALYSIS_PROVIDER: ${provider}`);
}

export function createLLMProvider(): LLMProvider {
  const provider = getAnalysisProviderName();

  if (provider === 'doubao') {
    return new DoubaoLLMProvider();
  }

  return new CozeLLMProvider();
}
