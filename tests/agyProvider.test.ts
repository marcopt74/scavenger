import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stepCountIs, streamText, tool } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  AgyLoginResponse,
  AgyModelsResponse,
  PublicSettings,
  TestConnectionResult,
} from '../src/shared/types.js';
import { parseAgyModelsOutput } from '../src/server/agyAuth.js';
import {
  createAgyLanguageModel,
  disposeAgySessionWorker,
  StreamingToolCallParser,
} from '../src/server/agyLanguageModel.js';
import { createApp } from '../src/server/index.js';
import { resetSettingsCache } from '../src/server/settingsStore.js';

const ENV_KEYS = [
  'SCAVENGER_CONFIG_PATH',
  'SCAVENGER_AGY_BIN',
  'SCAVENGER_AGY_ALLOW_CLI_CHECK',
  'SCAVENGER_COPILOT_CONFIG_DIR',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'MOCK_AGY_MODE',
  'MOCK_AGY_STATE_FILE',
] as const;

async function createMockAgyScript(dir: string): Promise<string> {
  const scriptPath = path.join(dir, 'mock-agy');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');

const args = process.argv.slice(2);
const mode = process.env.MOCK_AGY_MODE || 'ok';
const stateFile = process.env.MOCK_AGY_STATE_FILE || '';

function recordMeta(entry) {
  if (!stateFile) return;
  fs.appendFileSync(stateFile, JSON.stringify(entry) + '\\n', 'utf8');
}

if (args[0] === 'models') {
  if (mode === 'unauthenticated') {
    process.stderr.write('Error: user is not logged in. Please sign in.\\n');
    process.exit(1);
  }
  process.stdout.write(
    '\\r⠋ Fetching available models...\\r' +
    'gpt-oss-120b-medium            GPT-OSS 120B (Medium)\\n' +
    'gemini-4-carbon-high           Gemini 4 Carbon (High)\\n' +
    'gemini-4-hydrogen-high         Gemini 4 Hydrogen (High)\\n' +
    'gemini-4-neon-high             Gemini 4 Neon (High)\\n' +
    'gemini-4-argon-high            Gemini 4 Argon (High)\\n'
  );
  process.exit(0);
}

if (args[0] === 'acp' && args.includes('--login')) {
  if (mode === 'login-already') {
    process.stdout.write('Already authenticated.\\n');
    process.exit(0);
  }
  process.stdout.write('Open https://accounts.example.test/agy-device-auth to finish sign-in\\n');
  setTimeout(() => process.exit(0), 120);
  return;
}

if (args.includes('--input-format') && args.includes('stream-json')) {
  const modelIdx = args.indexOf('--model');
  const modelId = modelIdx >= 0 ? args[modelIdx + 1] : 'unknown';
  recordMeta({
    pid: process.pid,
    cwd: process.cwd(),
    args,
    modelId,
  });

  process.stdout.write(JSON.stringify({
    event: 'init',
    conversation_id: 'conv_mock_' + process.pid,
    init: { model: modelId, cwd: process.cwd(), permission_mode: 'plan' },
  }) + '\\n');

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let turnIndex = 0;
  let inFlightTurn = false;
  let pendingTimer = null;

  rl.on('close', () => {
    if (inFlightTurn) {
      if (pendingTimer) clearTimeout(pendingTimer);
      inFlightTurn = false;
      process.stdout.write(JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv_mock_' + process.pid,
          status: 'ERROR',
          error: 'stream input cancelled: context canceled',
        },
      }) + '\\n');
    }
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    const content = parsed?.message?.content || '';
    turnIndex += 1;
    inFlightTurn = true;

    pendingTimer = setTimeout(() => {
      inFlightTurn = false;
      pendingTimer = null;
      if (mode === 'tool-flow') {
        if (turnIndex === 1) {
          const chunk1 = '<scavenger_tool_';
          const chunk2 = 'call>{"name":"lookup_module","arguments":{"moduleId":"guard"}}</scavenger_tool_call>';
          process.stdout.write(JSON.stringify({
            event: 'step_update',
            step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: chunk1 },
          }) + '\\n');
          process.stdout.write(JSON.stringify({
            event: 'step_update',
            step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: chunk2 },
          }) + '\\n');
          process.stdout.write(JSON.stringify({
            event: 'result',
            result: {
              conversation_id: 'conv_mock_' + process.pid,
              status: 'SUCCESS',
              response: chunk1 + chunk2,
              usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 120 },
            },
          }) + '\\n');
          return;
        }

        const finalMsg = content.includes('pathGuard.ts')
          ? 'Verified guard module uses pathGuard.ts (pid=' + process.pid + ').'
          : 'Missing tool result.';
        process.stdout.write(JSON.stringify({
          event: 'step_update',
          step_update: { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: finalMsg.slice(0, 18) },
        }) + '\\n');
        process.stdout.write(JSON.stringify({
          event: 'step_update',
          step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: finalMsg.slice(18) },
        }) + '\\n');
        process.stdout.write(JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'conv_mock_' + process.pid,
            status: 'SUCCESS',
            response: finalMsg,
            usage: { input_tokens: 140, output_tokens: 25, thinking_tokens: 0, cache_read_tokens: 20, total_tokens: 165 },
          },
        }) + '\\n');
        return;
      }

      const reply = content.includes('Reply with OK.') ? 'OK' : 'Hello from Gemini 4 via agy (' + modelId + ')';
      process.stdout.write(JSON.stringify({
        event: 'step_update',
        step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: reply },
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv_mock_' + process.pid,
          status: 'SUCCESS',
          response: reply,
          usage: { input_tokens: 42, output_tokens: 8, thinking_tokens: 2, cache_read_tokens: 0, total_tokens: 50 },
        },
      }) + '\\n');
    }, 30);
  });
}
`;

  await fs.writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

describe('Antigravity (agy) provider & Gemini 4 integration', () => {
  let tempDir: string;
  let configPath: string;
  let mockAgyPath: string;
  let stateFile: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-agy-test-'));
    configPath = path.join(tempDir, 'config.json');
    stateFile = path.join(tempDir, 'mock-agy-invocations.jsonl');
    mockAgyPath = await createMockAgyScript(tempDir);

    process.env.SCAVENGER_CONFIG_PATH = configPath;
    process.env.MOCK_AGY_STATE_FILE = stateFile;
    resetSettingsCache();
  });

  afterEach(async () => {
    resetSettingsCache();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('parses agy models output, strips ANSI/spinner frames, and sorts Gemini 4 models first', () => {
    const raw = [
      '\r\x1b[36m⠋ Fetching available models...\x1b[0m\r',
      'I1127 11:24:00.123456 123 server.go:100] Starting language server',
      'gpt-oss-120b-medium            GPT-OSS 120B (Medium)',
      'gemini-3.8-flash-high          Gemini 3.8 Flash (High)',
      'gemini-4-carbon-high           Gemini 4 Carbon (High)',
      'gemini-4-hydrogen-high         Gemini 4 Hydrogen (High)',
      'gemini-4-neon-high             Gemini 4 Neon (High)',
      'gemini-4-argon-high            Gemini 4 Argon (High)',
    ].join('\n');

    const models = parseAgyModelsOutput(raw);
    expect(models.map((m) => m.id)).toEqual([
      'gemini-4-neon-high',
      'gemini-4-hydrogen-high',
      'gemini-4-argon-high',
      'gemini-4-carbon-high',
      'gemini-3.8-flash-high',
      'gpt-oss-120b-medium',
    ]);
    expect(models[0].label).toBe('Gemini 4 Neon (High)');
    expect(models[0].note).toBe('Gemini 4 Neon · High');
  });

  it('parses chunk-split <scavenger_tool_call> tags cleanly without leaking markup into prose', () => {
    const prose: string[] = [];
    const calls: Array<{ toolName: string; input: string }> = [];
    const parser = new StreamingToolCallParser(['read_file', 'render_diagram'], {
      onText: (d) => prose.push(d),
      onToolCall: (tc) => calls.push({ toolName: tc.toolName, input: tc.input }),
    });

    parser.push('Checking the file now. <scaven');
    parser.push('ger_tool_call>{"name":"read_file","arguments":{"path":"src/index.ts"}}</scav');
    parser.push('enger_tool_call> Done.');
    parser.flush();

    expect(prose.join('')).toBe('Checking the file now.  Done.');
    expect(calls).toEqual([
      { toolName: 'read_file', input: JSON.stringify({ path: 'src/index.ts' }) },
    ]);
  });

  it('discovers live Gemini 4 models via GET /api/settings/agy/models and handles unauthenticated / missing CLI states', async () => {
    const app = createApp();

    // 1. Missing CLI binary
    process.env.SCAVENGER_AGY_BIN = path.join(tempDir, 'does-not-exist');
    resetSettingsCache();
    const missingRes = await app.request('/api/settings/agy/models');
    expect(missingRes.status).toBe(200);
    const missingBody = (await missingRes.json()) as AgyModelsResponse;
    expect(missingBody.installed).toBe(false);
    expect(missingBody.authenticated).toBe(false);
    expect(missingBody.source).toBe('presets');

    // 2. Installed but unauthenticated
    process.env.SCAVENGER_AGY_BIN = mockAgyPath;
    process.env.MOCK_AGY_MODE = 'unauthenticated';
    resetSettingsCache();
    const unauthRes = await app.request('/api/settings/agy/models?refresh=true');
    const unauthBody = (await unauthRes.json()) as AgyModelsResponse;
    expect(unauthBody.installed).toBe(true);
    expect(unauthBody.authenticated).toBe(false);
    expect(unauthBody.error).toContain('agy acp --login');

    const unauthSettingsRes = await app.request('/api/settings');
    const unauthSettings = (await unauthSettingsRes.json()) as { settings: PublicSettings };
    expect(unauthSettings.settings.providers.agy.ready).toBe(false);

    // 3. Authenticated live discovery
    process.env.MOCK_AGY_MODE = 'ok';
    const liveRes = await app.request('/api/settings/agy/models?refresh=true');
    const liveBody = (await liveRes.json()) as AgyModelsResponse;
    expect(liveBody.installed).toBe(true);
    expect(liveBody.authenticated).toBe(true);
    expect(liveBody.source).toBe('live');
    expect(liveBody.models[0].id).toBe('gemini-4-neon-high');
    expect(liveBody.models.map((m) => m.id)).toContain('gemini-4-argon-high');
  });

  it('never stores credentials for agy in config.json and supports POST /api/settings/test', async () => {
    process.env.SCAVENGER_AGY_BIN = mockAgyPath;
    process.env.MOCK_AGY_MODE = 'ok';
    resetSettingsCache();

    const app = createApp();
    const saveRes = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        activeProvider: 'agy',
        providers: {
          agy: {
            model: 'gemini-4-neon-high',
            apiKey: 'personal-token-must-never-be-saved',
          },
        },
      }),
    });
    expect(saveRes.status).toBe(200);

    const diskConfig = await fs.readFile(configPath, 'utf8');
    expect(diskConfig).not.toContain('personal-token-must-never-be-saved');
    const parsedConfig = JSON.parse(diskConfig) as {
      activeProvider: string;
      providers: { agy: Record<string, unknown> };
    };
    expect(parsedConfig.activeProvider).toBe('agy');
    expect(parsedConfig.providers.agy).toEqual({ model: 'gemini-4-neon-high' });

    // Test connection end-to-end via mock agy binary
    const testRes = await app.request('/api/settings/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'agy', model: 'gemini-4-neon-high' }),
    });
    expect(testRes.status).toBe(200);
    const testBody = (await testRes.json()) as TestConnectionResult;
    expect(testBody.ok).toBe(true);
    expect(testBody.model).toBe('gemini-4-neon-high');

    // Verify agy ran in an isolated empty sandbox directory with read-only flags
    const rawMeta = (await fs.readFile(stateFile, 'utf8')).trim().split('\n');
    const invocation = JSON.parse(rawMeta[0]) as { cwd: string; args: string[]; modelId: string };
    expect(invocation.cwd).toContain('scavenger-agy-sandbox-');
    expect(invocation.args).toContain('--sandbox');
    expect(invocation.args).toContain('--disable-slash-commands');
    expect(invocation.args).not.toContain('--dangerously-skip-permissions');
    expect(invocation.modelId).toBe('gemini-4-neon-high');
  });

  it('supports multi-step streaming tool calls on a single warm agy session worker', async () => {
    process.env.SCAVENGER_AGY_BIN = mockAgyPath;
    process.env.MOCK_AGY_MODE = 'tool-flow';
    resetSettingsCache();

    const sessionKey = 'sess_warm_test';
    const model = createAgyLanguageModel({
      modelId: 'gemini-4-neon-high',
      sessionKey,
    });

    const executedTools: string[] = [];
    const result = streamText({
      model,
      system: 'You are Scavenger.',
      messages: [{ role: 'user', content: 'Explain the guard module.' }],
      tools: {
        lookup_module: tool({
          description: 'Look up a repository module',
          inputSchema: z.object({ moduleId: z.string() }),
          execute: async ({ moduleId }) => {
            executedTools.push(moduleId);
            return { files: ['src/server/guardrails/pathGuard.ts'] };
          },
        }),
      },
      stopWhen: stepCountIs(4),
    });

    let streamedText = '';
    for await (const delta of result.textStream) {
      streamedText += delta;
    }

    disposeAgySessionWorker(sessionKey);

    expect(executedTools).toEqual(['guard']);
    expect(streamedText).toContain('Verified guard module uses pathGuard.ts');

    // Only ONE mock agy process should have been spawned across both steps
    const invocations = (await fs.readFile(stateFile, 'utf8')).trim().split('\n');
    expect(invocations.length).toBe(1);
  });

  it('initiates agy login via POST /api/settings/agy/login and captures verification URL', async () => {
    process.env.SCAVENGER_AGY_BIN = mockAgyPath;
    process.env.MOCK_AGY_MODE = 'ok';
    resetSettingsCache();

    const app = createApp();
    const res = await app.request('/api/settings/agy/login', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgyLoginResponse;
    expect(body.status).toBe('started');
    expect(body.verificationUrl).toBe('https://accounts.example.test/agy-device-auth');
  });
});
