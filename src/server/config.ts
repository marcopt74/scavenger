import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ProviderId, ProviderSelection } from '../shared/types.js';

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  google: 'gemini-2.5-flash',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  'openai-compatible': 'llama3.2',
  demo: 'local-grounded-demo',
};

export function getConfiguredProviders(): Record<ProviderId, boolean> {
  const hasGoogle = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasCompat = Boolean(process.env.OPENAI_COMPATIBLE_BASE_URL);
  return {
    google: hasGoogle,
    openai: hasOpenAI,
    anthropic: hasAnthropic,
    'openai-compatible': hasCompat,
    demo: true,
  };
}

export function getDefaultProviderSelection(): ProviderSelection {
  const configured = getConfiguredProviders();
  const envProvider = (process.env.LLM_PROVIDER || '').trim().toLowerCase() as ProviderId;
  const envModel = (process.env.LLM_MODEL || '').trim() || undefined;
  const envBaseUrl = (process.env.OPENAI_COMPATIBLE_BASE_URL || '').trim() || undefined;

  const validProviders: ProviderId[] = ['google', 'openai', 'anthropic', 'openai-compatible', 'demo'];

  if (validProviders.includes(envProvider)) {
    if (envProvider === 'demo' || configured[envProvider]) {
      return {
        provider: envProvider,
        model: envModel || DEFAULT_MODELS[envProvider],
        baseUrl: envProvider === 'openai-compatible' ? envBaseUrl : undefined,
      };
    }
  }

  // Fallback to any configured real provider before demo
  for (const candidate of ['google', 'openai', 'anthropic', 'openai-compatible'] as const) {
    if (configured[candidate]) {
      return {
        provider: candidate,
        model: envModel || DEFAULT_MODELS[candidate],
        baseUrl: candidate === 'openai-compatible' ? envBaseUrl : undefined,
      };
    }
  }

  return {
    provider: 'demo',
    model: DEFAULT_MODELS.demo,
  };
}

export function resolveLanguageModel(selection: ProviderSelection): LanguageModel | null {
  const modelId = selection.model?.trim() || DEFAULT_MODELS[selection.provider];

  switch (selection.provider) {
    case 'demo':
      return null;

    case 'google': {
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error(
          'Google Gemini API key is missing. Set GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY) in .env, or switch to Demo mode.'
        );
      }
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelId);
    }

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OpenAI API key is missing. Set OPENAI_API_KEY in .env, or switch to Demo mode.');
      }
      const openai = createOpenAI({ apiKey });
      return openai(modelId);
    }

    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('Anthropic API key is missing. Set ANTHROPIC_API_KEY in .env, or switch to Demo mode.');
      }
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelId);
    }

    case 'openai-compatible': {
      const baseURL = selection.baseUrl?.trim() || process.env.OPENAI_COMPATIBLE_BASE_URL;
      if (!baseURL) {
        throw new Error(
          'OPENAI_COMPATIBLE_BASE_URL is missing. Configure a base URL (e.g., http://localhost:11434/v1 for Ollama).'
        );
      }
      const compat = createOpenAICompatible({
        name: 'openai-compatible',
        baseURL,
        apiKey: process.env.OPENAI_COMPATIBLE_API_KEY || 'not-needed',
      });
      return compat.chatModel(modelId);
    }

    default:
      throw new Error(`Unsupported provider: ${String(selection.provider)}`);
  }
}
