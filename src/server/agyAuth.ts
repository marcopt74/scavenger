import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROVIDER_MODEL_PRESETS,
  type AgyLoginResponse,
  type AgyModelsResponse,
  type ProviderModelPreset,
} from '../shared/types.js';

const MODELS_CACHE_TTL_MS = 5 * 60_000;
const BINARY_CACHE_TTL_MS = 30_000;

interface CachedAgyStatus {
  installed: boolean;
  authenticated: boolean;
  models: ProviderModelPreset[];
  source: 'live' | 'presets';
  error?: string;
  checkedAtMs: number;
}

let cachedBinary: { value: string | null; checkedAtMs: number } | null = null;
let cachedStatus: CachedAgyStatus | null = null;
let inflightProbe: Promise<AgyModelsResponse> | null = null;
let activeLoginInFlight = false;

export function resetAgyCaches(): void {
  cachedBinary = null;
  cachedStatus = null;
  inflightProbe = null;
  activeLoginInFlight = false;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the local `agy` CLI executable without reading or storing any credentials.
 * Respects `SCAVENGER_AGY_BIN` first; during isolated unit tests (`SCAVENGER_CONFIG_PATH` set),
 * host binary discovery is skipped unless `SCAVENGER_AGY_BIN` or `SCAVENGER_AGY_ALLOW_CLI_CHECK=true` is set.
 */
export function resolveAgyBinary(): string | null {
  const customBin = process.env.SCAVENGER_AGY_BIN?.trim();
  if (customBin) {
    const resolved = path.resolve(customBin);
    return isExecutableFile(resolved) ? resolved : null;
  }

  if (
    process.env.SCAVENGER_CONFIG_PATH?.trim() &&
    process.env.SCAVENGER_AGY_ALLOW_CLI_CHECK !== 'true'
  ) {
    return null;
  }

  const now = Date.now();
  if (cachedBinary && now - cachedBinary.checkedAtMs < BINARY_CACHE_TTL_MS) {
    return cachedBinary.value;
  }

  const candidateNames =
    process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy'];

  const searchDirs: string[] = [];
  if (process.env.PATH) {
    for (const dir of process.env.PATH.split(path.delimiter)) {
      if (dir.trim()) searchDirs.push(dir.trim());
    }
  }

  const home = os.homedir();
  searchDirs.push(path.join(home, '.local', 'bin'));
  if (process.platform === 'darwin') {
    searchDirs.push('/opt/homebrew/bin', '/usr/local/bin');
  }

  let found: string | null = null;
  for (const dir of Array.from(new Set(searchDirs))) {
    for (const name of candidateNames) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) {
        found = candidate;
        break;
      }
    }
    if (found) break;
  }

  cachedBinary = { value: found, checkedAtMs: now };
  return found;
}

function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

function deriveAgyModelNote(id: string, label: string): string {
  const lowerId = id.toLowerCase();
  if (lowerId.startsWith('gemini-4-')) {
    const effortMatch = lowerId.match(/-(low|medium|high|xhigh|max)$/);
    const effort = effortMatch
      ? effortMatch[1] === 'xhigh'
        ? 'XHigh'
        : effortMatch[1].charAt(0).toUpperCase() + effortMatch[1].slice(1)
      : undefined;
    if (lowerId.includes('neon')) return effort ? `Gemini 4 Neon · ${effort}` : 'Gemini 4 Neon';
    if (lowerId.includes('hydrogen')) return effort ? `Gemini 4 Hydrogen · ${effort}` : 'Gemini 4 Hydrogen';
    if (lowerId.includes('argon')) return effort ? `Gemini 4 Argon · ${effort}` : 'Gemini 4 Argon';
    if (lowerId.includes('carbon')) return effort ? `Gemini 4 Carbon · ${effort}` : 'Gemini 4 Carbon';
    return effort ? `Gemini 4 · ${effort}` : 'Gemini 4';
  }
  if (lowerId.startsWith('gemini-pro-orchestrator')) {
    return 'Antigravity Orchestrator';
  }
  if (lowerId.startsWith('gemini-')) {
    return 'Google Gemini (via agy)';
  }
  if (lowerId.startsWith('claude-')) {
    return 'Anthropic (via agy)';
  }
  if (lowerId.startsWith('gpt-')) {
    return 'OpenAI / OSS (via agy)';
  }
  return label !== id ? 'Antigravity CLI' : 'agy model';
}

function agyModelSortRank(id: string): number {
  const lower = id.toLowerCase();
  if (lower === 'gemini-4-neon-high') return 0;
  if (lower === 'gemini-4-neon-medium') return 1;
  if (lower.startsWith('gemini-4-neon')) return 2;
  if (lower === 'gemini-4-hydrogen-high') return 3;
  if (lower.startsWith('gemini-4-hydrogen')) return 4;
  if (lower === 'gemini-4-argon-high') return 5;
  if (lower.startsWith('gemini-4-argon')) return 6;
  if (lower === 'gemini-4-carbon-high') return 7;
  if (lower.startsWith('gemini-4-carbon')) return 8;
  if (lower.startsWith('gemini-4')) return 9;
  if (lower.startsWith('gemini-')) return 20;
  return 50;
}

/**
 * Parses stdout from `agy models`, stripping ANSI/spinner frames and prioritizing Gemini 4 models.
 */
export function parseAgyModelsOutput(rawOutput: string): ProviderModelPreset[] {
  const cleaned = stripAnsi(rawOutput);
  const rawSegments = cleaned.split(/[\r\n]+/);
  const seen = new Set<string>();
  const parsed: Array<{ preset: ProviderModelPreset; order: number }> = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const line = rawSegments[i].trim();
    if (!line) continue;
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)) continue;
    if (/^fetching available models/i.test(line)) continue;
    // Skip Go/glog diagnostic lines if any bleed into stdout
    if (/^[IWEF]\d{4}\s+\d{2}:\d{2}:\d{2}/.test(line)) continue;
    if (/^(ERROR|WARN|INFO|Usage|Flags|Available):/i.test(line)) continue;

    const match = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._:/-]{2,})(?:\s{2,}|\t+)(.+)$/);
    if (!match) continue;

    const id = match[1].trim();
    const label = match[2].trim();
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);

    parsed.push({
      preset: {
        id,
        label,
        note: deriveAgyModelNote(id, label),
      },
      order: i,
    });
  }

  parsed.sort((a, b) => {
    const rankDiff = agyModelSortRank(a.preset.id) - agyModelSortRank(b.preset.id);
    return rankDiff !== 0 ? rankDiff : a.order - b.order;
  });

  return parsed.map((entry) => entry.preset);
}

function runAgyModelsCommand(bin: string): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ['models'],
      {
        shell: false,
        timeout: 25_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const combined = `${stderr || ''}\n${stdout || ''}\n${err.message || ''}`.trim();
          resolve({ ok: false, stdout: stdout || '', stderr: stderr || '', error: combined });
          return;
        }
        resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
      }
    );
  });
}

function formatAgyAuthError(rawError?: string): string {
  const text = stripAnsi(rawError || '').trim();
  if (/not logged in|unauthenticated|sign in|login|auth|credential|token/i.test(text)) {
    return 'Antigravity CLI (agy) is not logged in. Click "Sign in with agy" or run `agy acp --login` in your terminal.';
  }
  if (/ETIMEDOUT|timed out/i.test(text)) {
    return 'Timed out querying `agy models`. Ensure `agy` is logged in (`agy acp --login`) and try refreshing.';
  }
  if (text) {
    const firstUsefulLine = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !/^[IWEF]\d{4}\s/.test(l));
    if (firstUsefulLine) {
      return `Unable to query \`agy models\`: ${firstUsefulLine.slice(0, 180)}`;
    }
  }
  return 'Antigravity CLI (agy) did not return available models. Run `agy acp --login` to authenticate.';
}

/**
 * Queries `agy models` asynchronously to verify the user's local `agy` login
 * and populate live Gemini 4 model options (cached for 5 minutes).
 */
export async function fetchAgyModels(options?: {
  forceRefresh?: boolean;
}): Promise<AgyModelsResponse> {
  const bin = resolveAgyBinary();
  if (!bin) {
    cachedStatus = {
      installed: false,
      authenticated: false,
      models: [...PROVIDER_MODEL_PRESETS.agy],
      source: 'presets',
      error: 'Antigravity CLI (`agy`) was not found on PATH.',
      checkedAtMs: Date.now(),
    };
    return {
      models: [...PROVIDER_MODEL_PRESETS.agy],
      source: 'presets',
      installed: false,
      authenticated: false,
      error: cachedStatus.error,
    };
  }

  const now = Date.now();
  if (
    !options?.forceRefresh &&
    cachedStatus &&
    cachedStatus.installed &&
    now - cachedStatus.checkedAtMs < MODELS_CACHE_TTL_MS
  ) {
    return {
      models: cachedStatus.models,
      source: cachedStatus.source,
      installed: cachedStatus.installed,
      authenticated: cachedStatus.authenticated,
      error: cachedStatus.error,
    };
  }

  if (!options?.forceRefresh && inflightProbe) {
    return inflightProbe;
  }

  const probePromise = (async (): Promise<AgyModelsResponse> => {
    const result = await runAgyModelsCommand(bin);
    const models = parseAgyModelsOutput(result.stdout);

    if (result.ok && models.length > 0) {
      cachedStatus = {
        installed: true,
        authenticated: true,
        models,
        source: 'live',
        checkedAtMs: Date.now(),
      };
      return {
        models,
        source: 'live',
        installed: true,
        authenticated: true,
      };
    }

    const errorMessage = formatAgyAuthError(result.error || result.stderr || result.stdout);
    cachedStatus = {
      installed: true,
      authenticated: false,
      models: [...PROVIDER_MODEL_PRESETS.agy],
      source: 'presets',
      error: errorMessage,
      checkedAtMs: Date.now(),
    };
    return {
      models: [...PROVIDER_MODEL_PRESETS.agy],
      source: 'presets',
      installed: true,
      authenticated: false,
      error: errorMessage,
    };
  })();

  inflightProbe = probePromise;
  try {
    return await probePromise;
  } finally {
    if (inflightProbe === probePromise) {
      inflightProbe = null;
    }
  }
}

export interface AgySyncReadiness {
  installed: boolean;
  ready: boolean;
  checked: boolean;
  sourceDetail?: string;
}

/**
 * Fast, non-blocking readiness check used by `/api/health` and `settingsStore`.
 * Never spawns a blocking subprocess; returns cached probe status or optimistic binary presence
 * while `warmAgyStatusCheck()` verifies authentication in the background.
 */
export function getAgyReadinessSync(): AgySyncReadiness {
  const bin = resolveAgyBinary();
  if (!bin) {
    return {
      installed: false,
      ready: false,
      checked: true,
      sourceDetail: 'agy CLI not installed',
    };
  }

  if (cachedStatus && cachedStatus.installed) {
    return {
      installed: true,
      ready: cachedStatus.authenticated,
      checked: true,
      sourceDetail: cachedStatus.authenticated
        ? 'agy CLI login'
        : 'Not signed in (run agy acp --login)',
    };
  }

  return {
    installed: true,
    ready: true,
    checked: false,
    sourceDetail: 'agy CLI login',
  };
}

/**
 * Triggers a non-blocking background probe of `agy models` if `agy` is installed.
 */
export function warmAgyStatusCheck(): void {
  if (!resolveAgyBinary()) return;
  if (cachedStatus || inflightProbe) return;
  void fetchAgyModels({ forceRefresh: false }).catch(() => {
    // Best-effort background warmup
  });
}

/**
 * Initiates interactive Google authentication via the documented `agy acp --login` command.
 * Scavenger never receives or stores any OAuth tokens; credentials remain managed by `agy`.
 */
export async function startAgyLogin(): Promise<AgyLoginResponse> {
  const bin = resolveAgyBinary();
  if (!bin) {
    return {
      status: 'not-installed',
      message: 'Antigravity CLI (`agy`) was not found on PATH. Install `agy` first, then sign in.',
    };
  }

  if (activeLoginInFlight) {
    return {
      status: 'started',
      message: 'An `agy` login flow is already in progress. Complete sign-in in your browser, then click Refresh models.',
    };
  }

  activeLoginInFlight = true;

  return new Promise<AgyLoginResponse>((resolve) => {
    let settled = false;
    let verificationUrl: string | undefined;
    let outputBuffer = '';

    const finish = (response: AgyLoginResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };

    const child = spawn(bin, ['acp', '--login'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    const handleChunk = (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString('utf8'));
      outputBuffer += text;
      if (!verificationUrl) {
        const urlMatch = outputBuffer.match(/https:\/\/[^\s"'<>]+/i);
        if (urlMatch) {
          verificationUrl = urlMatch[0].replace(/[).,;]+$/, '');
          finish({
            status: 'started',
            verificationUrl,
            message: 'Sign-in started via `agy acp --login`. Complete Google authentication in your browser, then click Refresh models.',
          });
        }
      }
    };

    child.stdout?.on('data', handleChunk);
    child.stderr?.on('data', handleChunk);

    child.on('error', (err) => {
      activeLoginInFlight = false;
      finish({
        status: 'error',
        message: `Failed to launch \`agy acp --login\`: ${err.message}`,
      });
    });

    child.on('exit', (code) => {
      activeLoginInFlight = false;
      if (code === 0) {
        cachedStatus = null;
        warmAgyStatusCheck();
        finish({
          status: 'already-authenticated',
          message: 'Antigravity (`agy`) login verified. Refreshing available Gemini 4 models…',
        });
      } else {
        finish({
          status: 'error',
          message: `\`agy acp --login\` exited with code ${code ?? 'unknown'}. You can also run \`agy acp --login\` directly in your terminal.`,
        });
      }
    });

    // If `agy acp --login` opened a browser without printing a URL to stdout, resolve promptly
    const timer = setTimeout(() => {
      finish({
        status: 'started',
        verificationUrl,
        message: 'Browser sign-in started via `agy acp --login`. Complete authentication in your browser, then click Refresh models.',
      });
    }, 3500);

    // Safety cap so a forgotten login child cannot linger indefinitely
    setTimeout(() => {
      if (activeLoginInFlight && !child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore
        }
      }
    }, 5 * 60_000).unref();
  });
}
