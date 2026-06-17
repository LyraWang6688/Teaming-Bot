import { DoubaoLLMProvider } from './doubaoProvider';
import type { LLMProvider } from './types';

export type AnalysisProviderName = 'doubao';

export function getAnalysisProviderName(): AnalysisProviderName {
  return 'doubao';
}

export function createLLMProvider(): LLMProvider {
  return new DoubaoLLMProvider();
}
