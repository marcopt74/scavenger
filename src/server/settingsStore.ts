import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ProviderId,
  ProviderPublicConfig,
  ProviderSelection,
  PublicSettings,
  SecretSource,
  UpdateSettingsPayload,
} from '../shared/types.js';

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  google: 'gemini-2.5-flash',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  'openai-compatible': 'llama3.2',
  demo: 'local-grounded-demo',
};

export const DEFAULT_GEMINI_IMAGE_MODEL = 'imagen-3.0-generate-002';
export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-1';

interface StoredProviderEntry {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

interface StoredSettingsFile {
  activeProvider?: ProviderId;
  providers?: Partial<Record<Exclude<ProviderId, 'demo'>, StoredProviderEntry>>;
  visuals?: {
    imageGenEnabled?: boolean;
    geminiImageModel?: string;
    openaiImageModel?: string;
  };
}

const VALID_PROVIDERS: readonly ProviderId[] = [
  'google',
  'openai',
  'anthropic',
  'openai-compatible',
  'demo',
];

let cachedPath: string | null = null;
let cachedData: StoredSettingsFile | null = null;

export function getSettingsFilePath(): string {
  const custom = process.env.SCAVENGER_CONFIG_PATH?.trim();
  if (custom) {
    return path.resolve(custom);
  }
  return path.join(os.homedir(), '.scavenger', 'config.json');
}

export function resetSettingsCache(): void {
  cachedPath = null;
  cachedData = null;
}

function readStoredSettings(): StoredSettingsFile {
  const filePath = getSettingsFilePath();
  if (cachedData && cachedPath === filePath) {
    return cachedData;
  }

  let parsed: StoredSettingsFile = {};
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const json = JSON.parse(raw) as unknown;
      if (json && typeof json === 'object') {
        parsed = json as StoredSettingsFile;
      }
    }
  } catch {
    parsed = {};
  }

  cachedPath = filePath;
  cachedData = parsed;
  return parsed;
}

function writeStoredSettings(next: StoredSettingsFile): void {
  const filePath = getSettingsFilePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmpPath = path.join(dir, `.config.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });

  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Ignore on platforms that do not support POSIX chmod
  }

  fs.renameSync(tmpPath, filePath);

  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Ignore on platforms that do not support POSIX chmod
  }

  cachedPath = filePath;
  cachedData = next;
}

export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (trimmed.length >= 12) {
    return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
  }
  if (trimmed.length >= 6) {
    return `${trimmed.slice(0, 2)}••••${trimmed.slice(-2)}`;
  }
  return '••••••';
}

function getEnvApiKey(provider: Exclude<ProviderId, 'demo'>): string | undefined {
  switch (provider) {
    case 'google':
      return (process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY || '').trim() || undefined;
    case 'openai':
      return (process.env.OPENAI_API_KEY || '').trim() || undefined;
    case 'anthropic':
      return (process.env.ANTHROPIC_API_KEY || '').trim() || undefined;
    case 'openai-compatible':
      return (process.env.OPENAI_COMPATIBLE_API_KEY || '').trim() || undefined;
  }
}

export function getEffectiveApiKey(provider: ProviderId): {
  value?: string;
  source: SecretSource;
} {
  if (provider === 'demo') {
    return { value: undefined, source: 'none' };
  }
  const stored = readStoredSettings();
  const storedKey = stored.providers?.[provider]?.apiKey?.trim();
  if (storedKey) {
    return { value: storedKey, source: 'settings' };
  }
  const envKey = getEnvApiKey(provider);
  if (envKey) {
    return { value: envKey, source: 'env' };
  }
  return { value: undefined, source: 'none' };
}

export function getEffectiveBaseUrl(): { value?: string; source: SecretSource } {
  const stored = readStoredSettings();
  const storedUrl = stored.providers?.['openai-compatible']?.baseUrl?.trim();
  if (storedUrl) {
    return { value: storedUrl, source: 'settings' };
  }
  const envUrl = (process.env.OPENAI_COMPATIBLE_BASE_URL || '').trim();
  if (envUrl) {
    return { value: envUrl, source: 'env' };
  }
  return { value: undefined, source: 'none' };
}

export function getEffectiveModel(provider: ProviderId): string {
  if (provider === 'demo') {
    return DEFAULT_MODELS.demo;
  }
  const stored = readStoredSettings();
  const storedModel = stored.providers?.[provider]?.model?.trim();
  if (storedModel) {
    return storedModel;
  }
  const envProvider = (process.env.LLM_PROVIDER || '').trim().toLowerCase() as ProviderId;
  const envModel = (process.env.LLM_MODEL || '').trim();
  if (envModel && (!envProvider || envProvider === provider)) {
    return envModel;
  }
  return DEFAULT_MODELS[provider];
}

export function getEffectiveConfiguredProviders(): Record<ProviderId, boolean> {
  return {
    google: Boolean(getEffectiveApiKey('google').value),
    openai: Boolean(getEffectiveApiKey('openai').value),
    anthropic: Boolean(getEffectiveApiKey('anthropic').value),
    'openai-compatible': Boolean(getEffectiveBaseUrl().value),
    demo: true,
  };
}

export function getEffectiveDefaultProviderSelection(): ProviderSelection {
  const stored = readStoredSettings();
  const configured = getEffectiveConfiguredProviders();

  if (stored.activeProvider && VALID_PROVIDERS.includes(stored.activeProvider)) {
    const active = stored.activeProvider;
    if (active === 'demo' || configured[active]) {
      return {
        provider: active,
        model: getEffectiveModel(active),
        baseUrl: active === 'openai-compatible' ? getEffectiveBaseUrl().value : undefined,
      };
    }
  }

  const envProvider = (process.env.LLM_PROVIDER || '').trim().toLowerCase() as ProviderId;
  if (VALID_PROVIDERS.includes(envProvider)) {
    if (envProvider === 'demo' || configured[envProvider]) {
      return {
        provider: envProvider,
        model: getEffectiveModel(envProvider),
        baseUrl: envProvider === 'openai-compatible' ? getEffectiveBaseUrl().value : undefined,
      };
    }
  }

  for (const candidate of ['google', 'openai', 'anthropic', 'openai-compatible'] as const) {
    if (configured[candidate]) {
      return {
        provider: candidate,
        model: getEffectiveModel(candidate),
        baseUrl: candidate === 'openai-compatible' ? getEffectiveBaseUrl().value : undefined,
      };
    }
  }

  return {
    provider: 'demo',
    model: DEFAULT_MODELS.demo,
  };
}

export interface EffectiveVisualSettings {
  imageGenEnabled: boolean;
  geminiImageModel: string;
  openaiImageModel: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  imageGenAvailable: boolean;
}

export function getEffectiveVisualSettings(): EffectiveVisualSettings {
  const stored = readStoredSettings();

  const imageGenEnabled =
    typeof stored.visuals?.imageGenEnabled === 'boolean'
      ? stored.visuals.imageGenEnabled
      : process.env.IMAGE_GEN_ENABLED !== 'false';

  const geminiImageModel =
    stored.visuals?.geminiImageModel?.trim() ||
    process.env.GEMINI_IMAGE_MODEL?.trim() ||
    DEFAULT_GEMINI_IMAGE_MODEL;

  const openaiImageModel =
    stored.visuals?.openaiImageModel?.trim() ||
    process.env.OPENAI_IMAGE_MODEL?.trim() ||
    DEFAULT_OPENAI_IMAGE_MODEL;

  const geminiApiKey = getEffectiveApiKey('google').value;
  const openaiApiKey = getEffectiveApiKey('openai').value;
  const imageGenAvailable = imageGenEnabled && Boolean(geminiApiKey || openaiApiKey);

  return {
    imageGenEnabled,
    geminiImageModel,
    openaiImageModel,
    geminiApiKey,
    openaiApiKey,
    imageGenAvailable,
  };
}

export function getPublicSettings(capabilities: { d2Available: boolean }): PublicSettings {
  const selection = getEffectiveDefaultProviderSelection();
  const configured = getEffectiveConfiguredProviders();
  const visuals = getEffectiveVisualSettings();

  const buildProviderPublic = (id: ProviderId): ProviderPublicConfig => {
    const keyInfo = getEffectiveApiKey(id);
    const baseUrlInfo = id === 'openai-compatible' ? getEffectiveBaseUrl() : undefined;
    return {
      provider: id,
      model: getEffectiveModel(id),
      baseUrl: baseUrlInfo?.value,
      hasKey: Boolean(keyInfo.value),
      maskedKey: keyInfo.value ? maskApiKey(keyInfo.value) : undefined,
      keySource: keyInfo.source,
      ready: configured[id],
    };
  };

  return {
    activeProvider: selection.provider,
    providers: {
      google: buildProviderPublic('google'),
      openai: buildProviderPublic('openai'),
      anthropic: buildProviderPublic('anthropic'),
      'openai-compatible': buildProviderPublic('openai-compatible'),
      demo: buildProviderPublic('demo'),
    },
    visuals: {
      imageGenEnabled: visuals.imageGenEnabled,
      geminiImageModel: visuals.geminiImageModel,
      openaiImageModel: visuals.openaiImageModel,
      imageGenAvailable: visuals.imageGenAvailable,
      d2Available: capabilities.d2Available,
    },
    storagePath: getSettingsFilePath(),
  };
}

export function updateStoredSettings(patch: UpdateSettingsPayload): StoredSettingsFile {
  const current = readStoredSettings();
  const next: StoredSettingsFile = {
    activeProvider: current.activeProvider,
    providers: { ...(current.providers ?? {}) },
    visuals: { ...(current.visuals ?? {}) },
  };

  if (patch.activeProvider && VALID_PROVIDERS.includes(patch.activeProvider)) {
    next.activeProvider = patch.activeProvider;
  }

  if (patch.providers) {
    const providerIds = ['google', 'openai', 'anthropic', 'openai-compatible'] as const;
    for (const id of providerIds) {
      const update = patch.providers[id];
      if (!update) continue;

      const existing: StoredProviderEntry = { ...(next.providers?.[id] ?? {}) };

      if (update.model !== undefined) {
        const trimmed = update.model.trim();
        if (trimmed) existing.model = trimmed;
        else delete existing.model;
      }

      if (id === 'openai-compatible' && update.baseUrl !== undefined) {
        const trimmed = update.baseUrl.trim();
        if (trimmed) existing.baseUrl = trimmed;
        else delete existing.baseUrl;
      }

      if (update.clearApiKey) {
        delete existing.apiKey;
      } else if (update.apiKey !== undefined && update.apiKey.trim().length > 0) {
        existing.apiKey = update.apiKey.trim();
      }

      if (Object.keys(existing).length > 0) {
        next.providers![id] = existing;
      } else {
        delete next.providers![id];
      }
    }
  }

  if (patch.visuals) {
    if (typeof patch.visuals.imageGenEnabled === 'boolean') {
      next.visuals!.imageGenEnabled = patch.visuals.imageGenEnabled;
    }
    if (patch.visuals.geminiImageModel !== undefined) {
      const trimmed = patch.visuals.geminiImageModel.trim();
      if (trimmed) next.visuals!.geminiImageModel = trimmed;
      else delete next.visuals!.geminiImageModel;
    }
    if (patch.visuals.openaiImageModel !== undefined) {
      const trimmed = patch.visuals.openaiImageModel.trim();
      if (trimmed) next.visuals!.openaiImageModel = trimmed;
      else delete next.visuals!.openaiImageModel;
    }
  }

  writeStoredSettings(next);
  return next;
}
