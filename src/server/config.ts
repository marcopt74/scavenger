import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ProviderId, ProviderSelection } from '../shared/types.js';
import { createAgyLanguageModel } from './agyLanguageModel.js';
import { resolveAgyBinary } from './agyAuth.js';
import { createCopilotFetch, DEFAULT_COPILOT_API_BASE } from './copilotAuth.js';
import {
  DEFAULT_MODELS,
  getEffectiveApiKey,
  getEffectiveBaseUrl,
  getEffectiveConfiguredProviders,
  getEffectiveCopilotDomain,
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
  sessionKey?: string;
}

export function resolveLanguageModel(
  selection: ProviderSelection,
  overrides?: ModelInlineOverrides
): LanguageModel | null {
  const modelId = selection.model?.trim() || getEffectiveModel(selection.provider);

  switch (selection.provider) {
    case 'demo':
      return null;

    case 'agy': {
      const agyBin = resolveAgyBinary();
      if (!agyBin) {
        throw new Error(
          'Antigravity CLI (`agy`) was not found on PATH. Install `agy`, sign in with `agy acp --login`, or switch providers in Settings.'
        );
      }
      return createAgyLanguageModel({
        modelId,
        sessionKey: overrides?.sessionKey,
      });
    }

    case 'copilot': {
      const apiKey = overrides?.apiKey?.trim() || getEffectiveApiKey('copilot').value;
      if (!apiKey) {
        throw new Error(
          'GitHub Copilot authentication is missing. Sign in with GitHub Copilot in Settings (gear icon), authenticate via GitHub Copilot IDE/CLI, set GITHUB_COPILOT_TOKEN in .env, or switch to Demo mode.'
        );
      }
      const customDomain =
        overrides?.baseUrl?.trim() ||
        selection.baseUrl?.trim() ||
        getEffectiveCopilotDomain().value;
      const copilot = createOpenAICompatible({
        name: 'copilot',
        baseURL: DEFAULT_COPILOT_API_BASE,
        apiKey: 'copilot-session',
        fetch: createCopilotFetch(apiKey, customDomain),
      });
      return copilot.chatModel(modelId);
    }

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
