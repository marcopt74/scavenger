import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HealthInfo, PublicSettings, TestConnectionResult } from '../src/shared/types.js';
import { createApp } from '../src/server/index.js';
import {
  getEffectiveConfiguredProviders,
  getEffectiveDefaultProviderSelection,
  maskApiKey,
  resetSettingsCache,
} from '../src/server/settingsStore.js';
import { isImageGenConfigured } from '../src/server/tools/visualTools.js';

const ENV_KEYS = [
  'SCAVENGER_CONFIG_PATH',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_API_KEY',
  'IMAGE_GEN_ENABLED',
  'GEMINI_IMAGE_MODEL',
  'OPENAI_IMAGE_MODEL',
] as const;

describe('settingsStore & /api/settings endpoints', () => {
  let tempDir: string;
  let configPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-settings-'));
    configPath = path.join(tempDir, 'config.json');
    process.env.SCAVENGER_CONFIG_PATH = configPath;
    resetSettingsCache();
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetSettingsCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('masks API keys safely without exposing raw secrets', () => {
    expect(maskApiKey('AIzaSyA1B2C3D4E5F6G7H8')).toBe('AIza••••G7H8');
    expect(maskApiKey('short123')).toBe('sh••••23');
    expect(maskApiKey('abc')).toBe('••••••');
  });

  it('reflects .env keys as masked previews with keySource="env" and never returns plaintext keys', async () => {
    process.env.OPENAI_API_KEY = 'sk-env-secret-key-987654321';
    resetSettingsCache();

    const app = createApp();
    const res = await app.request('/api/settings');
    expect(res.status).toBe(200);

    const rawText = await res.text();
    expect(rawText).not.toContain('sk-env-secret-key-987654321');

    const { settings } = JSON.parse(rawText) as { settings: PublicSettings };
    expect(settings.providers.openai.hasKey).toBe(true);
    expect(settings.providers.openai.keySource).toBe('env');
    expect(settings.providers.openai.maskedKey).toBe('sk-e••••4321');
    expect(settings.providers.google.hasKey).toBe(false);
    expect(settings.providers.google.keySource).toBe('none');
  });

  it('persists API keys, active provider, models, baseUrl, and visuals with 0600 permissions', async () => {
    const app = createApp();
    const putRes = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        activeProvider: 'anthropic',
        providers: {
          anthropic: {
            model: 'claude-3-7-sonnet-latest',
            apiKey: 'sk-ant-ui-saved-key-123456',
          },
          'openai-compatible': {
            model: 'qwen2.5-coder:14b',
            baseUrl: 'http://localhost:11434/v1',
          },
        },
        visuals: {
          imageGenEnabled: false,
          geminiImageModel: 'imagen-3.0-fast',
        },
      }),
    });

    expect(putRes.status).toBe(200);
    const putText = await putRes.text();
    expect(putText).not.toContain('sk-ant-ui-saved-key-123456');

    const { settings, health } = JSON.parse(putText) as {
      settings: PublicSettings;
      health: HealthInfo;
    };

    expect(settings.activeProvider).toBe('anthropic');
    expect(settings.providers.anthropic.model).toBe('claude-3-7-sonnet-latest');
    expect(settings.providers.anthropic.hasKey).toBe(true);
    expect(settings.providers.anthropic.keySource).toBe('settings');
    expect(settings.providers.anthropic.maskedKey).toBe('sk-a••••3456');
    expect(settings.providers['openai-compatible'].baseUrl).toBe('http://localhost:11434/v1');
    expect(settings.providers['openai-compatible'].ready).toBe(true);
    expect(settings.visuals.imageGenEnabled).toBe(false);
    expect(settings.visuals.geminiImageModel).toBe('imagen-3.0-fast');

    expect(health.defaultProvider).toBe('anthropic');
    expect(health.defaultModel).toBe('claude-3-7-sonnet-latest');
    expect(health.configuredProviders.anthropic).toBe(true);
    expect(health.configuredProviders['openai-compatible']).toBe(true);
    expect(health.imageGenAvailable).toBe(false);

    // Check file permissions on POSIX
    if (process.platform !== 'win32') {
      const stat = await fs.stat(configPath);
      expect(stat.mode & 0o777).toBe(0o600);
    }

    // Reload from disk after cache reset
    resetSettingsCache();
    expect(getEffectiveDefaultProviderSelection()).toEqual({
      provider: 'anthropic',
      model: 'claude-3-7-sonnet-latest',
      baseUrl: undefined,
    });
    expect(getEffectiveConfiguredProviders().anthropic).toBe(true);
  });

  it('preserves saved API keys when updating models and supports explicit clearApiKey with .env fallback', async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'AIzaEnvFallbackKey1111';
    resetSettingsCache();

    const app = createApp();

    // Save a UI key overriding .env
    await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        activeProvider: 'google',
        providers: {
          google: { model: 'gemini-2.5-flash', apiKey: 'AIzaUiOverrideKey9999' },
        },
      }),
    });

    // Update only the model (apiKey omitted) -> UI key must stay intact
    const updateModelRes = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: {
          google: { model: 'gemini-2.5-pro' },
        },
      }),
    });
    const afterModel = (await updateModelRes.json()) as { settings: PublicSettings };
    expect(afterModel.settings.providers.google.model).toBe('gemini-2.5-pro');
    expect(afterModel.settings.providers.google.keySource).toBe('settings');
    expect(afterModel.settings.providers.google.maskedKey).toBe('AIza••••9999');
    expect(isImageGenConfigured()).toBe(true);

    // Explicitly clear the UI key -> falls back cleanly to .env key
    const clearRes = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: {
          google: { clearApiKey: true },
        },
      }),
    });
    const afterClear = (await clearRes.json()) as { settings: PublicSettings };
    expect(afterClear.settings.providers.google.keySource).toBe('env');
    expect(afterClear.settings.providers.google.maskedKey).toBe('AIza••••1111');
  });

  it('rejects malformed base URLs with HTTP 400', async () => {
    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: {
          'openai-compatible': { baseUrl: 'not-a-valid-url' },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('http://');
  });

  it('supports POST /api/settings/test for demo mode and reports missing keys cleanly', async () => {
    const app = createApp();

    const demoRes = await app.request('/api/settings/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'demo' }),
    });
    expect(demoRes.status).toBe(200);
    const demoJson = (await demoRes.json()) as TestConnectionResult;
    expect(demoJson.ok).toBe(true);

    const missingKeyRes = await app.request('/api/settings/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-4o' }),
    });
    expect(missingKeyRes.status).toBe(200);
    const missingJson = (await missingKeyRes.json()) as TestConnectionResult;
    expect(missingJson.ok).toBe(false);
    expect(missingJson.message).toContain('OpenAI API key is missing');
  });
});
