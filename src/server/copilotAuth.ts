import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROVIDER_MODEL_PRESETS,
  type CopilotDeviceFlowStartResponse,
  type CopilotModelsResponse,
  type ProviderModelPreset,
} from '../shared/types.js';

export const COPILOT_OAUTH_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
export const DEFAULT_COPILOT_API_BASE = 'https://api.githubcopilot.com';
const DEFAULT_TOKEN_EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token';

export interface NormalizedGitHubDomain {
  host: string;
  webOrigin: string;
  tokenExchangeUrls: string[];
  defaultCopilotApiBase: string;
}

export function normalizeGitHubDomain(rawDomain?: string): NormalizedGitHubDomain {
  const trimmed = (rawDomain || '').trim();
  if (!trimmed) {
    return {
      host: 'github.com',
      webOrigin: 'https://github.com',
      tokenExchangeUrls: [DEFAULT_TOKEN_EXCHANGE_URL],
      defaultCopilotApiBase: DEFAULT_COPILOT_API_BASE,
    };
  }

  let protocol = 'https:';
  let host = trimmed;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      protocol = parsed.protocol;
      host = parsed.host.toLowerCase();
    } catch {
      host = trimmed.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    }
  } else {
    host = trimmed.replace(/\/+$/, '').split('/')[0].toLowerCase();
  }

  if (!host || host === 'github.com' || host === 'www.github.com') {
    return {
      host: 'github.com',
      webOrigin: 'https://github.com',
      tokenExchangeUrls: [DEFAULT_TOKEN_EXCHANGE_URL],
      defaultCopilotApiBase: DEFAULT_COPILOT_API_BASE,
    };
  }

  const webOrigin = `${protocol}//${host}`;

  if (host.endsWith('.ghe.com')) {
    return {
      host,
      webOrigin,
      tokenExchangeUrls: [
        `${protocol}//api.${host}/copilot_internal/v2/token`,
        `${webOrigin}/api/v3/copilot_internal/v2/token`,
      ],
      defaultCopilotApiBase: `${protocol}//copilot-api.${host}`,
    };
  }

  return {
    host,
    webOrigin,
    tokenExchangeUrls: [
      `${webOrigin}/api/v3/copilot_internal/v2/token`,
      `${protocol}//api.${host}/copilot_internal/v2/token`,
      DEFAULT_TOKEN_EXCHANGE_URL,
    ],
    defaultCopilotApiBase: DEFAULT_COPILOT_API_BASE,
  };
}

export const COPILOT_EDITOR_HEADERS: Record<string, string> = {
  'Editor-Version': 'vscode/1.99.0',
  'Editor-Plugin-Version': 'copilot-chat/0.26.7',
  'Copilot-Integration-Id': 'vscode-chat',
  'Openai-Intent': 'conversation-panel',
  'User-Agent': 'GitHubCopilotChat/0.26.7',
};

interface CachedCopilotSession {
  bearerToken: string;
  apiBaseUrl: string;
  expiresAtMs: number;
}

interface CachedModelsEntry {
  models: ProviderModelPreset[];
  fetchedAtMs: number;
}

const sessionCache = new Map<string, CachedCopilotSession>();
const modelsCache = new Map<string, CachedModelsEntry>();

let ghCliTokenCache: { token: string | null; checkedAtMs: number } | null = null;

export function resetCopilotCaches(): void {
  sessionCache.clear();
  modelsCache.clear();
  ghCliTokenCache = null;
}

function getCandidateCopilotConfigDirs(): string[] {
  const customDir = process.env.SCAVENGER_COPILOT_CONFIG_DIR?.trim();
  if (customDir) {
    return [path.resolve(customDir)];
  }

  // When running with an isolated SCAVENGER_CONFIG_PATH (e.g. unit tests) and no explicit
  // SCAVENGER_COPILOT_CONFIG_DIR, do not read host-level Copilot files from ~/.config.
  if (process.env.SCAVENGER_CONFIG_PATH?.trim()) {
    return [];
  }

  const home = os.homedir();
  const dirs: string[] = [];

  if (process.env.XDG_CONFIG_HOME?.trim()) {
    dirs.push(path.join(process.env.XDG_CONFIG_HOME.trim(), 'github-copilot'));
  }
  dirs.push(path.join(home, '.config', 'github-copilot'));

  if (process.platform === 'win32' && process.env.LOCALAPPDATA?.trim()) {
    dirs.push(path.join(process.env.LOCALAPPDATA.trim(), 'github-copilot'));
  }
  if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'github-copilot'));
  }

  return Array.from(new Set(dirs));
}

function extractTokenFromCopilotConfigJson(
  raw: unknown,
  preferredHost?: string
): { token: string; domain?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;

  // Direct token fields (e.g. ~/.copilot/config.json)
  for (const field of ['oauth_token', 'github_token', 'token']) {
    const val = obj[field];
    if (typeof val === 'string' && val.trim()) {
      const hostField = typeof obj.host === 'string' ? obj.host.trim() : undefined;
      return { token: val.trim(), domain: hostField };
    }
  }

  const normalizedPreferred = preferredHost ? normalizeGitHubDomain(preferredHost).host : undefined;
  const candidates: Array<{ token: string; domain: string }> = [];

  // Standard hosts.json / apps.json shape: { "github.com:Iv1...": { "oauth_token": "ghu_..." }, "company.ghe.com:Iv1...": { ... } }
  for (const [key, entry] of Object.entries(obj)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const rawToken =
      typeof record.oauth_token === 'string' && record.oauth_token.trim()
        ? record.oauth_token.trim()
        : typeof record.token === 'string' && record.token.trim()
          ? record.token.trim()
          : undefined;
    if (!rawToken) continue;

    const entryHost = key.split(':')[0].trim().toLowerCase() || 'github.com';
    candidates.push({ token: rawToken, domain: entryHost });
  }

  if (candidates.length === 0) return undefined;

  if (normalizedPreferred) {
    const matched = candidates.find((c) => c.domain === normalizedPreferred);
    if (matched) return matched;
  }

  return candidates[0];
}

function readGhCliToken(preferredHost?: string): string | undefined {
  // When running with an isolated test config dir or custom SCAVENGER_CONFIG_PATH, skip spawning external gh CLI unless explicitly enabled
  if (
    (process.env.SCAVENGER_COPILOT_CONFIG_DIR?.trim() ||
      process.env.SCAVENGER_CONFIG_PATH?.trim()) &&
    process.env.SCAVENGER_COPILOT_ALLOW_GH_FALLBACK !== 'true'
  ) {
    return undefined;
  }

  const host = preferredHost ? normalizeGitHubDomain(preferredHost).host : 'github.com';
  const now = Date.now();
  if (!preferredHost && ghCliTokenCache && now - ghCliTokenCache.checkedAtMs < 60_000) {
    return ghCliTokenCache.token ?? undefined;
  }

  try {
    const args = host && host !== 'github.com' ? ['auth', 'token', '--hostname', host] : ['auth', 'token'];
    const out = execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const token = out.length > 0 ? out : null;
    if (!preferredHost) {
      ghCliTokenCache = { token, checkedAtMs: now };
    }
    return token ?? undefined;
  } catch {
    if (!preferredHost) {
      ghCliTokenCache = { token: null, checkedAtMs: now };
    }
    return undefined;
  }
}

export interface DiscoveredCopilotToken {
  token: string;
  sourceDetail: string;
  domain?: string;
}

export function discoverLocalCopilotToken(preferredDomain?: string): DiscoveredCopilotToken | null {
  const dirs = getCandidateCopilotConfigDirs();
  for (const dir of dirs) {
    for (const filename of ['hosts.json', 'apps.json']) {
      const filePath = path.join(dir, filename);
      try {
        if (!fs.existsSync(filePath)) continue;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        const extracted = extractTokenFromCopilotConfigJson(parsed, preferredDomain);
        if (extracted) {
          return {
            token: extracted.token,
            sourceDetail:
              extracted.domain && extracted.domain !== 'github.com'
                ? `github-copilot/${filename} (${extracted.domain})`
                : `github-copilot/${filename}`,
            domain: extracted.domain,
          };
        }
      } catch {
        // Ignore unreadable or malformed local config files
      }
    }
  }

  // Also check ~/.copilot/config.json when not in isolated test dir
  if (
    !process.env.SCAVENGER_COPILOT_CONFIG_DIR?.trim() &&
    !process.env.SCAVENGER_CONFIG_PATH?.trim()
  ) {
    const dotCopilotConfig = path.join(os.homedir(), '.copilot', 'config.json');
    try {
      if (fs.existsSync(dotCopilotConfig)) {
        const parsed = JSON.parse(fs.readFileSync(dotCopilotConfig, 'utf8')) as unknown;
        const extracted = extractTokenFromCopilotConfigJson(parsed, preferredDomain);
        if (extracted) {
          return {
            token: extracted.token,
            sourceDetail: '~/.copilot/config.json',
            domain: extracted.domain,
          };
        }
      }
    } catch {
      // Ignore
    }
  }

  const ghToken = readGhCliToken(preferredDomain);
  if (ghToken) {
    const host = preferredDomain ? normalizeGitHubDomain(preferredDomain).host : undefined;
    return {
      token: ghToken,
      sourceDetail: host && host !== 'github.com' ? `gh auth token (${host})` : 'gh auth token',
      domain: host,
    };
  }

  return null;
}

export async function resolveCopilotApiSession(
  rawToken: string,
  forceRefresh = false,
  customDomain?: string
): Promise<CachedCopilotSession> {
  const trimmed = rawToken.trim();
  const domainInfo = normalizeGitHubDomain(customDomain);

  // If the token is already a short-lived Copilot session token (`tid=...`), use it directly
  if (trimmed.startsWith('tid=')) {
    return {
      bearerToken: trimmed,
      apiBaseUrl: domainInfo.defaultCopilotApiBase,
      expiresAtMs: Date.now() + 10 * 60_000,
    };
  }

  const cacheKey = `${trimmed}::${domainInfo.host}`;
  const now = Date.now();
  const cached = sessionCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAtMs - now > 60_000) {
    return cached;
  }

  const envExchangeUrl = process.env.GITHUB_COPILOT_TOKEN_URL?.trim();
  const exchangeUrls = envExchangeUrl ? [envExchangeUrl] : domainInfo.tokenExchangeUrls;

  for (const exchangeUrl of exchangeUrls) {
    try {
      const res = await fetch(exchangeUrl, {
        method: 'GET',
        headers: {
          Authorization: `token ${trimmed}`,
          Accept: 'application/json',
          ...COPILOT_EDITOR_HEADERS,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          token?: string;
          expires_at?: number;
          endpoints?: { api?: string };
        };
        if (data.token && typeof data.token === 'string') {
          const apiBaseUrl = (
            data.endpoints?.api || domainInfo.defaultCopilotApiBase
          ).replace(/\/+$/, '');
          const expiresAtMs =
            typeof data.expires_at === 'number' && data.expires_at > 0
              ? data.expires_at * 1000
              : now + 25 * 60_000;

          const session: CachedCopilotSession = {
            bearerToken: data.token,
            apiBaseUrl,
            expiresAtMs,
          };
          sessionCache.set(cacheKey, session);
          return session;
        }
      }
    } catch {
      // Try next candidate token exchange URL or fall through to direct bearer fallback
    }
  }

  // Fallback: Newer Copilot API endpoints also accept GitHub OAuth tokens (e.g. gho_/ghu_) directly as Bearer tokens
  const fallbackSession: CachedCopilotSession = {
    bearerToken: trimmed,
    apiBaseUrl: domainInfo.defaultCopilotApiBase,
    expiresAtMs: now + 5 * 60_000,
  };
  sessionCache.set(cacheKey, fallbackSession);
  return fallbackSession;
}

function rewriteCopilotUrl(inputUrl: string, targetBaseUrl: string): string {
  const normalizedTarget = targetBaseUrl.replace(/\/+$/, '');
  if (inputUrl.startsWith(DEFAULT_COPILOT_API_BASE)) {
    return `${normalizedTarget}${inputUrl.slice(DEFAULT_COPILOT_API_BASE.length)}`;
  }
  return inputUrl;
}

export function createCopilotFetch(
  rawToken: string,
  customBaseUrl?: string
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const executeWithSession = async (forceRefresh: boolean): Promise<Response> => {
      const session = await resolveCopilotApiSession(rawToken, forceRefresh, customBaseUrl);
      const targetUrl = rewriteCopilotUrl(urlStr, session.apiBaseUrl);

      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(COPILOT_EDITOR_HEADERS)) {
        if (!headers.has(k)) {
          headers.set(k, v);
        }
      }
      headers.set('Authorization', `Bearer ${session.bearerToken}`);

      return fetch(targetUrl, {
        ...init,
        headers,
      });
    };

    const firstRes = await executeWithSession(false);
    if (firstRes.status === 401) {
      const domainHost = normalizeGitHubDomain(customBaseUrl).host;
      sessionCache.delete(`${rawToken.trim()}::${domainHost}`);
      return executeWithSession(true);
    }
    return firstRes;
  };
}

interface RawCopilotModelEntry {
  id?: string;
  name?: string;
  vendor?: string;
  version?: string;
  preview?: boolean;
  model_picker_enabled?: boolean;
  capabilities?: {
    type?: string;
    family?: string;
    supports?: {
      tool_calls?: boolean;
      streaming?: boolean;
    };
  };
}

function parseCopilotModelsList(payload: unknown): ProviderModelPreset[] {
  const list: RawCopilotModelEntry[] = Array.isArray(payload)
    ? (payload as RawCopilotModelEntry[])
    : payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: RawCopilotModelEntry[] }).data)
      : [];

  const chatModels = list.filter((entry) => {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) return false;
    const id = entry.id.trim().toLowerCase();
    const capType = entry.capabilities?.type?.toLowerCase();
    if (capType && capType !== 'chat') return false;
    if (id.includes('embedding') || id.includes('moderation')) return false;
    return true;
  });

  // Sort picker-enabled models first so primary user-facing models appear at the top
  chatModels.sort((a, b) => {
    const aPicker = a.model_picker_enabled === true ? 0 : a.model_picker_enabled === false ? 2 : 1;
    const bPicker = b.model_picker_enabled === true ? 0 : b.model_picker_enabled === false ? 2 : 1;
    return aPicker - bPicker;
  });

  const seen = new Set<string>();
  const presets: ProviderModelPreset[] = [];

  for (const m of chatModels) {
    const id = m.id!.trim();
    if (seen.has(id)) continue;
    seen.add(id);

    const label = m.name?.trim() || id;
    const noteParts: string[] = [];
    if (m.vendor?.trim()) {
      noteParts.push(m.vendor.trim().replace(/^Azure OpenAI$/i, 'OpenAI'));
    }
    if (m.preview) {
      noteParts.push('Preview');
    }
    const note = noteParts.join(' · ') || 'Copilot Chat';

    presets.push({ id, label, note });
  }

  return presets;
}

export async function fetchCopilotModels(options?: {
  rawToken?: string;
  baseUrl?: string;
  forceRefresh?: boolean;
}): Promise<CopilotModelsResponse> {
  const rawToken = options?.rawToken?.trim();
  if (!rawToken) {
    return {
      models: [...PROVIDER_MODEL_PRESETS.copilot],
      source: 'presets',
    };
  }

  const cacheKey = `${rawToken}::${options?.baseUrl?.trim() || ''}`;
  const now = Date.now();
  const cached = modelsCache.get(cacheKey);
  if (!options?.forceRefresh && cached && now - cached.fetchedAtMs < 5 * 60_000) {
    return {
      models: cached.models,
      source: 'live',
    };
  }

  try {
    const session = await resolveCopilotApiSession(
      rawToken,
      Boolean(options?.forceRefresh),
      options?.baseUrl
    );
    const modelsUrl = `${session.apiBaseUrl}/models`;

    const res = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${session.bearerToken}`,
        Accept: 'application/json',
        ...COPILOT_EDITOR_HEADERS,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return {
        models: [...PROVIDER_MODEL_PRESETS.copilot],
        source: 'presets',
        error: `Copilot /models returned HTTP ${res.status}. Showing default Copilot models.`,
      };
    }

    const json = (await res.json()) as unknown;
    const parsed = parseCopilotModelsList(json);
    if (parsed.length === 0) {
      return {
        models: [...PROVIDER_MODEL_PRESETS.copilot],
        source: 'presets',
      };
    }

    modelsCache.set(cacheKey, { models: parsed, fetchedAtMs: now });
    return {
      models: parsed,
      source: 'live',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to query Copilot models.';
    return {
      models: [...PROVIDER_MODEL_PRESETS.copilot],
      source: 'presets',
      error: msg,
    };
  }
}

export async function startCopilotDeviceFlow(
  domain?: string
): Promise<CopilotDeviceFlowStartResponse> {
  const domainInfo = normalizeGitHubDomain(domain);
  const url =
    process.env.GITHUB_COPILOT_DEVICE_CODE_URL?.trim() ||
    `${domainInfo.webOrigin}/login/device/code`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': COPILOT_EDITOR_HEADERS['User-Agent'],
    },
    body: JSON.stringify({
      client_id: COPILOT_OAUTH_CLIENT_ID,
      scope: 'read:user',
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(
      `GitHub device code request to ${domainInfo.host} failed (HTTP ${res.status}).`
    );
  }

  const data = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error_description?: string;
  };

  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(data.error_description || 'Invalid response from GitHub device login.');
  }

  const verificationUri = data.verification_uri.startsWith('http')
    ? data.verification_uri
    : `${domainInfo.webOrigin}${data.verification_uri.startsWith('/') ? '' : '/'}${data.verification_uri}`;

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 900,
    interval: typeof data.interval === 'number' ? data.interval : 5,
    domain: domainInfo.host,
  };
}

export interface DevicePollOutcome {
  status: 'pending' | 'slow_down' | 'complete' | 'expired' | 'denied';
  accessToken?: string;
  interval?: number;
  message?: string;
}

export async function pollCopilotDeviceFlow(
  deviceCode: string,
  domain?: string
): Promise<DevicePollOutcome> {
  const domainInfo = normalizeGitHubDomain(domain);
  const url =
    process.env.GITHUB_COPILOT_DEVICE_TOKEN_URL?.trim() ||
    `${domainInfo.webOrigin}/login/oauth/access_token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': COPILOT_EDITOR_HEADERS['User-Agent'],
    },
    body: JSON.stringify({
      client_id: COPILOT_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(
      `GitHub device token poll on ${domainInfo.host} failed (HTTP ${res.status}).`
    );
  }

  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
    interval?: number;
  };

  if (data.access_token && typeof data.access_token === 'string') {
    return {
      status: 'complete',
      accessToken: data.access_token.trim(),
    };
  }

  switch (data.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return {
        status: 'slow_down',
        interval: typeof data.interval === 'number' ? data.interval : 10,
      };
    case 'expired_token':
      return {
        status: 'expired',
        message: 'Device code expired. Please start a new GitHub Copilot sign-in.',
      };
    case 'access_denied':
      return {
        status: 'denied',
        message: 'GitHub sign-in was cancelled or denied.',
      };
    default:
      throw new Error(data.error_description || data.error || 'Unexpected response from GitHub OAuth.');
  }
}
