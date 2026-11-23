import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CopilotDeviceFlowPollResponse,
  CopilotDeviceFlowStartResponse,
  CopilotModelsResponse,
  HealthInfo,
  PublicSettings,
  TestConnectionResult,
} from '../src/shared/types.js';
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
  'SCAVENGER_COPILOT_CONFIG_DIR',
  'SCAVENGER_COPILOT_ALLOW_GH_FALLBACK',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'GITHUB_COPILOT_TOKEN',
  'GITHUB_COPILOT_DOMAIN',
  'GITHUB_ENTERPRISE_URL',
  'COPILOT_GITHUB_TOKEN',
  'GH_COPILOT_TOKEN',
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
    vi.restoreAllMocks();
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

  it('auto-detects local GitHub Copilot hosts.json token with keySource="local" and respects settings/.env precedence', async () => {
    const copilotDir = path.join(tempDir, 'github-copilot');
    await fs.mkdir(copilotDir, { recursive: true });
    await fs.writeFile(
      path.join(copilotDir, 'hosts.json'),
      JSON.stringify({
        'github.com:Iv1.b507a08c87ecfe98': {
          user: 'octocat',
          oauth_token: 'ghu_LocalAutoDetectedSecretToken9999',
        },
      }),
      'utf8'
    );
    process.env.SCAVENGER_COPILOT_CONFIG_DIR = copilotDir;
    resetSettingsCache();

    const app = createApp();
    const res = await app.request('/api/settings');
    expect(res.status).toBe(200);
    const rawText = await res.text();
    expect(rawText).not.toContain('ghu_LocalAutoDetectedSecretToken9999');

    const { settings } = JSON.parse(rawText) as { settings: PublicSettings };
    expect(settings.providers.copilot.ready).toBe(true);
    expect(settings.providers.copilot.hasKey).toBe(true);
    expect(settings.providers.copilot.keySource).toBe('local');
    expect(settings.providers.copilot.sourceDetail).toBe('github-copilot/hosts.json');
    expect(settings.providers.copilot.maskedKey).toBe('ghu_••••9999');
    expect(settings.activeProvider).toBe('copilot');

    // .env token overrides local auto-detected token
    process.env.GITHUB_COPILOT_TOKEN = 'ghu_EnvOverrideToken5555';
    resetSettingsCache();
    const envRes = await app.request('/api/settings');
    const envSettings = (await envRes.json()) as { settings: PublicSettings };
    expect(envSettings.settings.providers.copilot.keySource).toBe('env');
    expect(envSettings.settings.providers.copilot.maskedKey).toBe('ghu_••••5555');
  });

  it('exchanges Copilot token and discovers live chat models from /models while filtering out embeddings', async () => {
    process.env.GITHUB_COPILOT_TOKEN = 'ghu_TestOAuthToken123456';
    resetSettingsCache();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('copilot_internal/v2/token')) {
        return new Response(
          JSON.stringify({
            token: 'tid=short_lived_session_token',
            expires_at: Math.floor(Date.now() / 1000) + 1800,
            endpoints: { api: 'https://api.individual.githubcopilot.com' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === 'https://api.individual.githubcopilot.com/models') {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'claude-sonnet-4',
                name: 'Claude Sonnet 4',
                vendor: 'Anthropic',
                model_picker_enabled: true,
                capabilities: { type: 'chat' },
              },
              {
                id: 'gpt-4.1',
                name: 'GPT-4.1',
                vendor: 'Azure OpenAI',
                model_picker_enabled: true,
                capabilities: { type: 'chat' },
              },
              {
                id: 'text-embedding-3-small',
                name: 'Embedding 3 Small',
                capabilities: { type: 'embeddings' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const app = createApp();
    const res = await app.request('/api/settings/copilot/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as CopilotModelsResponse;

    expect(body.source).toBe('live');
    expect(body.models.map((m) => m.id)).toEqual(['claude-sonnet-4', 'gpt-4.1']);
    expect(body.models[0].note).toBe('Anthropic');
    expect(body.models[1].note).toBe('OpenAI');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('supports GitHub Copilot Device Flow start and poll endpoints and saves the OAuth token on completion', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/login/device/code')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev_code_abc123',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/login/oauth/access_token')) {
        return new Response(
          JSON.stringify({
            access_token: 'ghu_DeviceFlowCompletedToken7788',
            token_type: 'bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const app = createApp();
    const startRes = await app.request('/api/settings/copilot/device/start', { method: 'POST' });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as CopilotDeviceFlowStartResponse;
    expect(startBody.userCode).toBe('ABCD-1234');
    expect(startBody.deviceCode).toBe('dev_code_abc123');

    const pollRes = await app.request('/api/settings/copilot/device/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: startBody.deviceCode }),
    });
    expect(pollRes.status).toBe(200);
    const pollBody = (await pollRes.json()) as CopilotDeviceFlowPollResponse;
    expect(pollBody.status).toBe('complete');
    expect(pollBody.settings?.activeProvider).toBe('copilot');
    expect(pollBody.settings?.providers.copilot.keySource).toBe('settings');
    expect(pollBody.settings?.providers.copilot.maskedKey).toBe('ghu_••••7788');
    expect(pollBody.health?.configuredProviders.copilot).toBe(true);
  });

  it('supports organizational GitHub domain for Copilot device login, token exchange, and hosts.json discovery', async () => {
    const requestedUrls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      if (url === 'https://acme.ghe.com/login/device/code') {
        return new Response(
          JSON.stringify({
            device_code: 'org_dev_code_999',
            user_code: 'ORGC-9999',
            verification_uri: 'https://acme.ghe.com/login/device',
            expires_in: 900,
            interval: 5,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === 'https://acme.ghe.com/login/oauth/access_token') {
        return new Response(
          JSON.stringify({
            access_token: 'ghu_OrgEnterpriseToken4455',
            token_type: 'bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const app = createApp();
    const startRes = await app.request('/api/settings/copilot/device/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'acme.ghe.com' }),
    });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as CopilotDeviceFlowStartResponse;
    expect(startBody.domain).toBe('acme.ghe.com');
    expect(startBody.verificationUri).toBe('https://acme.ghe.com/login/device');

    const pollRes = await app.request('/api/settings/copilot/device/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: startBody.deviceCode, domain: 'acme.ghe.com' }),
    });
    expect(pollRes.status).toBe(200);
    const pollBody = (await pollRes.json()) as CopilotDeviceFlowPollResponse;
    expect(pollBody.status).toBe('complete');
    expect(pollBody.settings?.providers.copilot.baseUrl).toBe('acme.ghe.com');
    expect(requestedUrls).toEqual([
      'https://acme.ghe.com/login/device/code',
      'https://acme.ghe.com/login/oauth/access_token',
    ]);
  });
});
