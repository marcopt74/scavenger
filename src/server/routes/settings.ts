import { generateText } from 'ai';
import { Hono } from 'hono';
import { z } from 'zod';
import type { HealthInfo, ProviderId, TestConnectionResult } from '../../shared/types.js';
import {
  DEFAULT_MODELS,
  getConfiguredProviders,
  getDefaultProviderSelection,
  resolveLanguageModel,
} from '../config.js';
import { getEffectiveModel, getPublicSettings, updateStoredSettings } from '../settingsStore.js';
import { checkD2Available, isImageGenConfigured } from '../tools/visualTools.js';

const providerIdEnum = z.enum(['google', 'openai', 'anthropic', 'openai-compatible', 'demo']);

const httpUrlSchema = z
  .string()
  .trim()
  .refine(
    (val) => {
      if (!val) return true;
      try {
        const parsed = new URL(val);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'Base URL must be a valid http:// or https:// URL.' }
  );

const providerUpdateSchema = z.object({
  model: z.string().max(160).optional(),
  baseUrl: httpUrlSchema.optional(),
  apiKey: z.string().max(512).optional(),
  clearApiKey: z.boolean().optional(),
});

const updateSettingsSchema = z.object({
  activeProvider: providerIdEnum.optional(),
  providers: z
    .object({
      google: providerUpdateSchema.optional(),
      openai: providerUpdateSchema.optional(),
      anthropic: providerUpdateSchema.optional(),
      'openai-compatible': providerUpdateSchema.optional(),
    })
    .optional(),
  visuals: z
    .object({
      imageGenEnabled: z.boolean().optional(),
      geminiImageModel: z.string().max(160).optional(),
      openaiImageModel: z.string().max(160).optional(),
    })
    .optional(),
});

const testConnectionSchema = z.object({
  provider: providerIdEnum,
  model: z.string().max(160).optional(),
  baseUrl: httpUrlSchema.optional(),
  apiKey: z.string().max(512).optional(),
});

export const settingsRouter = new Hono();

async function buildHealthSnapshot(): Promise<HealthInfo> {
  const selection = getDefaultProviderSelection();
  return {
    ok: true,
    defaultProvider: selection.provider,
    defaultModel: selection.model || DEFAULT_MODELS[selection.provider],
    defaultBaseUrl: selection.baseUrl,
    configuredProviders: getConfiguredProviders(),
    d2Available: await checkD2Available(),
    imageGenAvailable: isImageGenConfigured(),
    suggestedRepoPath: process.cwd(),
  };
}

settingsRouter.get('/', async (c) => {
  const d2Available = await checkD2Available();
  return c.json({ settings: getPublicSettings({ d2Available }) });
});

settingsRouter.put('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body.' }, 400);
  }

  const parsed = updateSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message || 'Invalid settings payload.' },
      400
    );
  }

  try {
    updateStoredSettings(parsed.data);
    const health = await buildHealthSnapshot();
    const settings = getPublicSettings({ d2Available: health.d2Available });
    return c.json({ settings, health });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save settings.';
    return c.json({ error: message }, 500);
  }
});

settingsRouter.post('/test', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body.' }, 400);
  }

  const parsed = testConnectionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message || 'Invalid connection test payload.' },
      400
    );
  }

  const provider = parsed.data.provider as ProviderId;
  const modelId = parsed.data.model?.trim() || getEffectiveModel(provider);
  const startedAt = Date.now();

  if (provider === 'demo') {
    const res: TestConnectionResult = {
      ok: true,
      provider,
      model: DEFAULT_MODELS.demo,
      latencyMs: 0,
      message: 'Local Grounded Demo mode is ready (no API key required).',
    };
    return c.json(res);
  }

  try {
    const languageModel = resolveLanguageModel(
      {
        provider,
        model: modelId,
        baseUrl: parsed.data.baseUrl?.trim() || undefined,
      },
      {
        apiKey: parsed.data.apiKey?.trim() || undefined,
        baseUrl: parsed.data.baseUrl?.trim() || undefined,
      }
    );

    if (!languageModel) {
      const res: TestConnectionResult = {
        ok: true,
        provider,
        model: modelId,
        latencyMs: Date.now() - startedAt,
        message: 'Provider is ready.',
      };
      return c.json(res);
    }

    await generateText({
      model: languageModel,
      prompt: 'Reply with OK.',
      maxOutputTokens: 8,
      abortSignal: AbortSignal.timeout(12_000),
    });

    const latencyMs = Date.now() - startedAt;
    const res: TestConnectionResult = {
      ok: true,
      provider,
      model: modelId,
      latencyMs,
      message: `Connected to ${modelId} (${latencyMs}ms).`,
    };
    return c.json(res);
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const rawMsg = err instanceof Error ? err.message : 'Connection test failed.';
    const res: TestConnectionResult = {
      ok: false,
      provider,
      model: modelId,
      latencyMs,
      message: rawMsg.slice(0, 260),
    };
    return c.json(res, 200);
  }
});
