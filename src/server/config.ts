import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ProviderId, ProviderSelection } from '../shared/types.js';
import {
  DEFAULT_MODELS,
  getEffectiveApiKey,
  getEffectiveBaseUrl,
  getEffectiveConfiguredProviders,
  getEffectiveDefaultProviderSelection,
  getEffectiveModel,
} from './settingsStore.js';

export { DEFAULT_MODELS };

export function getConfiguredProviders(): Record<ProviderId, boolean> {
  return getEffectiveConfiguredProviders();
}

export function getDefaultProviderSelection(): ProviderSelection {
  return getEffectiveDefaultProviderSelection();
}

export interface ModelInlineOverrides {
  apiKey?: string;
  baseUrl?: string;
}

export function resolveLanguageModel(
  selection: ProviderSelection,
  overrides?: ModelInlineOverrides
): LanguageModel | null {
  const modelId = selection.model?.trim() || getEffectiveModel(selection.provider);

  switch (selection.provider) {
    case 'demo':
      return null;

    case 'google': {
      const apiKey = overrides?.apiKey?.trim() || getEffectiveApiKey('google').value;
      if (!apiKey) {
        throw new Error(
          'Google Gemini API key is missing. Add it in Settings (gear icon), set GOOGLE_GENERATIVE_AI_API_KEY in .env, or switch to Demo mode.'
        );
      }
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelId);
    }

    case 'openai': {
      const apiKey = overrides?.apiKey?.trim() || getEffectiveApiKey('openai').value;
      if (!apiKey) {
        throw new Error(
          'OpenAI API key is missing. Add it in Settings (gear icon), set OPENAI_API_KEY in .env, or switch to Demo mode.'
        );
      }
      const openai = createOpenAI({ apiKey });
      return openai(modelId);
    }

    case 'anthropic': {
      const apiKey = overrides?.apiKey?.trim() || getEffectiveApiKey('anthropic').value;
      if (!apiKey) {
        throw new Error(
          'Anthropic API key is missing. Add it in Settings (gear icon), set ANTHROPIC_API_KEY in .env, or switch to Demo mode.'
        );
      }
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelId);
    }

    case 'openai-compatible': {
      const baseURL =
        overrides?.baseUrl?.trim() || selection.baseUrl?.trim() || getEffectiveBaseUrl().value;
      if (!baseURL) {
        throw new Error(
          'OpenAI-compatible Base URL is missing. Configure a base URL in Settings (e.g., http://localhost:11434/v1 for Ollama).'
        );
      }
      const apiKey =
        overrides?.apiKey?.trim() || getEffectiveApiKey('openai-compatible').value || 'not-needed';
      const compat = createOpenAICompatible({
        name: 'openai-compatible',
        baseURL,
        apiKey,
      });
      return compat.chatModel(modelId);
    }

    default:
      throw new Error(`Unsupported provider: ${String(selection.provider)}`);
  }
}
