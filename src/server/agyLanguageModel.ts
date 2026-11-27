import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LanguageModel } from 'ai';
import { resolveAgyBinary } from './agyAuth.js';

type V4LanguageModel = Extract<LanguageModel, { specificationVersion: 'v4' }>;
type V4CallOptions = Parameters<V4LanguageModel['doGenerate']>[0];
type V4GenerateResult = Awaited<ReturnType<V4LanguageModel['doGenerate']>>;
type V4StreamResult = Awaited<ReturnType<V4LanguageModel['doStream']>>;
type V4StreamPart = V4StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
type V4PromptMessage = V4CallOptions['prompt'][number];
type V4Usage = V4GenerateResult['usage'];
type V4Content = V4GenerateResult['content'][number];

const OPEN_TOOL_TAG = '<scavenger_tool_call>';
const CLOSE_TOOL_TAG = '</scavenger_tool_call>';
const WORKER_IDLE_TTL_MS = 5 * 60_000;

let sharedSandboxDir: string | null = null;
let exitHooksRegistered = false;

function getIsolatedAgySandboxDir(): string {
  if (sharedSandboxDir && fs.existsSync(sharedSandboxDir)) {
    return sharedSandboxDir;
  }
  const dir = path.join(os.tmpdir(), `scavenger-agy-sandbox-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  sharedSandboxDir = dir;
  ensureExitHooks();
  return dir;
}

interface ParsedToolCall {
  toolCallId: string;
  toolName: string;
  input: string;
}

interface AgyTurnResult {
  text: string;
  usage: V4Usage;
  conversationId?: string;
}

interface AgyNdjsonUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

function mapAgyUsage(raw?: AgyNdjsonUsage): V4Usage {
  const inputTotal = typeof raw?.input_tokens === 'number' ? raw.input_tokens : undefined;
  const cacheRead = typeof raw?.cache_read_tokens === 'number' ? raw.cache_read_tokens : undefined;
  const noCache =
    inputTotal !== undefined && cacheRead !== undefined
      ? Math.max(0, inputTotal - cacheRead)
      : inputTotal;
  const outputTotal = typeof raw?.output_tokens === 'number' ? raw.output_tokens : undefined;
  const reasoning = typeof raw?.thinking_tokens === 'number' ? raw.thinking_tokens : undefined;
  const textTokens =
    outputTotal !== undefined && reasoning !== undefined
      ? Math.max(0, outputTotal - reasoning)
      : outputTotal;

  return {
    inputTokens: {
      total: inputTotal,
      noCache,
      cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTotal,
      text: textTokens,
      reasoning,
    },
  };
}

/**
 * Incrementally separates streaming prose from `<scavenger_tool_call>{...}</scavenger_tool_call>` blocks
 * with only a minimal lookahead tail so normal prose streams token-by-token.
 */
export class StreamingToolCallParser {
  private mode: 'prose' | 'tool' = 'prose';
  private proseBuffer = '';
  private toolBuffer = '';
  private readonly allowedTools: Set<string>;
  private readonly onText: (delta: string) => void;
  private readonly onToolCall: (call: ParsedToolCall) => void;

  constructor(
    allowedToolNames: Iterable<string>,
    callbacks: {
      onText: (delta: string) => void;
      onToolCall: (call: ParsedToolCall) => void;
    }
  ) {
    this.allowedTools = new Set(allowedToolNames);
    this.onText = callbacks.onText;
    this.onToolCall = callbacks.onToolCall;
  }

  push(chunk: string): void {
    if (!chunk) return;

    if (this.allowedTools.size === 0) {
      this.onText(chunk);
      return;
    }

    let remaining = chunk;
    while (remaining.length > 0) {
      if (this.mode === 'prose') {
        this.proseBuffer += remaining;
        remaining = '';

        const openIdx = this.proseBuffer.toLowerCase().indexOf(OPEN_TOOL_TAG);
        if (openIdx >= 0) {
          const before = this.proseBuffer.slice(0, openIdx);
          if (before) this.onText(before);
          const afterOpen = this.proseBuffer.slice(openIdx + OPEN_TOOL_TAG.length);
          this.proseBuffer = '';
          this.mode = 'tool';
          remaining = afterOpen;
        } else {
          // Keep a short tail in case `<scavenger_tool_call>` spans across chunk boundaries
          const safeLen = this.proseBuffer.length - (OPEN_TOOL_TAG.length - 1);
          if (safeLen > 0) {
            this.onText(this.proseBuffer.slice(0, safeLen));
            this.proseBuffer = this.proseBuffer.slice(safeLen);
          }
        }
      } else {
        this.toolBuffer += remaining;
        remaining = '';

        const closeIdx = this.toolBuffer.toLowerCase().indexOf(CLOSE_TOOL_TAG);
        if (closeIdx >= 0) {
          const rawBody = this.toolBuffer.slice(0, closeIdx).trim();
          const afterClose = this.toolBuffer.slice(closeIdx + CLOSE_TOOL_TAG.length);
          this.toolBuffer = '';
          this.mode = 'prose';

          const parsed = this.tryParseToolCall(rawBody);
          if (parsed) {
            this.onToolCall(parsed);
          } else if (rawBody) {
            // Fall back to emitting raw text if malformed or unknown tool
            this.onText(`${OPEN_TOOL_TAG}${rawBody}${CLOSE_TOOL_TAG}`);
          }

          remaining = afterClose;
        }
      }
    }
  }

  flush(): void {
    if (this.mode === 'prose') {
      if (this.proseBuffer) {
        this.onText(this.proseBuffer);
        this.proseBuffer = '';
      }
    } else if (this.toolBuffer) {
      // Unclosed tag at end of stream: try parsing in case closing tag was truncated, otherwise emit as prose
      const parsed = this.tryParseToolCall(this.toolBuffer.trim());
      if (parsed) {
        this.onToolCall(parsed);
      } else {
        this.onText(`${OPEN_TOOL_TAG}${this.toolBuffer}`);
      }
      this.toolBuffer = '';
      this.mode = 'prose';
    }
  }

  private tryParseToolCall(rawBody: string): ParsedToolCall | null {
    if (!rawBody) return null;
    const fenced = rawBody.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    const candidate = (fenced ? fenced[1] : rawBody).trim();
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;

    try {
      const obj = JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as {
        name?: unknown;
        toolName?: unknown;
        arguments?: unknown;
        args?: unknown;
        input?: unknown;
      };
      const toolName =
        typeof obj.name === 'string'
          ? obj.name.trim()
          : typeof obj.toolName === 'string'
            ? obj.toolName.trim()
            : '';
      if (!toolName || !this.allowedTools.has(toolName)) {
        return null;
      }

      const rawArgs = obj.arguments ?? obj.args ?? obj.input ?? {};
      const inputJson =
        typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});

      return {
        toolCallId: `agy_tc_${crypto.randomUUID().slice(0, 10)}`,
        toolName,
        input: inputJson,
      };
    } catch {
      return null;
    }
  }
}

function serializePromptMessage(msg: V4PromptMessage): string {
  switch (msg.role) {
    case 'system':
      return `[SYSTEM]\n${msg.content}`;

    case 'user': {
      const parts = msg.content
        .map((part) => {
          if (part.type === 'text') return part.text;
          return `[${part.type} attachment]`;
        })
        .filter(Boolean)
        .join('\n');
      return `[USER]\n${parts}`;
    }

    case 'assistant': {
      const parts = msg.content
        .map((part) => {
          if (part.type === 'text') return part.text;
          if (part.type === 'tool-call') {
            const serializedInput =
              typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {});
            return `${OPEN_TOOL_TAG}${JSON.stringify({ name: part.toolName, arguments: safeJsonParse(serializedInput) })}${CLOSE_TOOL_TAG}`;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
      return `[ASSISTANT]\n${parts}`;
    }

    case 'tool': {
      const blocks = msg.content
        .filter((part) => part.type === 'tool-result')
        .map((part) => {
          const serializedOutput =
            part.output && typeof part.output === 'object' && 'value' in part.output
              ? typeof part.output.value === 'string'
                ? part.output.value
                : JSON.stringify(part.output.value)
              : JSON.stringify(part.output);
          return `<scavenger_tool_result name="${part.toolName}" id="${part.toolCallId}">\n${serializedOutput}\n</scavenger_tool_result>`;
        })
        .join('\n\n');
      return `[TOOL RESULTS]\n${blocks}`;
    }
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractFunctionTools(options: V4CallOptions): Array<{
  name: string;
  description?: string;
  inputSchema: unknown;
}> {
  if (!options.tools || options.tools.length === 0) return [];
  return options.tools
    .filter((t) => t.type === 'function')
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
}

function buildToolBridgeInstructions(
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>
): string {
  const specs = tools
    .map((t) =>
      JSON.stringify(
        {
          name: t.name,
          description: t.description ?? '',
          parameters: t.inputSchema,
        },
        null,
        2
      )
    )
    .join('\n\n');

  return [
    '=== SCAVENGER RUNTIME ENVIRONMENT & TOOL PROTOCOL ===',
    'You are serving as the language model backend inside Scavenger (a strictly read-only repository onboarding app).',
    'CRITICAL RULES:',
    '1. Do NOT invoke any built-in Antigravity/CLI tools (no view_file, list_dir, grep_search, run_command, browser, write_to_file, etc.). Your working directory is an empty sandbox with zero access to the user repository.',
    '2. To inspect the repository, render inline Mermaid/D2 diagrams, generate concept visuals, or update learning progress/Quick Check/Next Steps, you MUST emit one or more Scavenger tool call tags using this EXACT format:',
    `${OPEN_TOOL_TAG}{"name":"tool_name","arguments":{...}}${CLOSE_TOOL_TAG}`,
    '3. Whenever you emit one or more `<scavenger_tool_call>` blocks, STOP your response immediately after the closing tag(s) so Scavenger can execute those tools and return `<scavenger_tool_result>` blocks on the next turn.',
    '4. When you have the information needed and are ready to deliver the final lesson to the user, respond directly in clean Markdown prose WITHOUT any `<scavenger_tool_call>` tags.',
    '',
    'Available Scavenger Tools:',
    specs,
    '=== END TOOL PROTOCOL ===',
  ].join('\n');
}

function buildFullPromptText(options: V4CallOptions): string {
  const functionTools = extractFunctionTools(options);
  const sections: string[] = [];

  if (functionTools.length > 0) {
    sections.push(buildToolBridgeInstructions(functionTools));
  } else {
    sections.push(
      [
        '=== SCAVENGER DIRECT GENERATION MODE ===',
        'Do NOT invoke any built-in CLI, filesystem, shell, or browser tools.',
        'Respond directly and concisely to the prompt below.',
        '=== END MODE ===',
      ].join('\n')
    );
  }

  for (const msg of options.prompt) {
    sections.push(serializePromptMessage(msg));
  }

  return sections.join('\n\n');
}

function buildIncrementalPromptText(
  newMessages: readonly V4PromptMessage[],
  updatedSystemText?: string
): string {
  const sections: string[] = [];
  if (updatedSystemText) {
    sections.push(`[UPDATED SYSTEM CONTEXT]\n${updatedSystemText}`);
  }
  for (const msg of newMessages) {
    sections.push(serializePromptMessage(msg));
  }
  if (newMessages.some((m) => m.role === 'tool')) {
    sections.push(
      'Continue your onboarding turn using the `<scavenger_tool_result>` output above. Emit additional `<scavenger_tool_call>` blocks if you still need to inspect files, render diagrams, or call `update_learning_state`; otherwise write your final Markdown lesson directly.'
    );
  }
  return sections.join('\n\n');
}

/**
 * Manages a single warm `agy --input-format stream-json --output-format stream-json` subprocess
 * running inside an isolated empty sandbox directory.
 */
class AgyStreamWorker {
  readonly modelId: string;
  private readonly agyBin: string;
  private child: ChildProcess | null = null;
  private stdoutRemainder = '';
  private stderrTail = '';
  private closed = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private turnQueue: Promise<unknown> = Promise.resolve();

  // Context tracking for safe incremental multi-step & multi-turn reuse
  private sentMessageCount = 0;
  private lastSystemText = '';
  private lastToolSignature = '';

  private activeTurn: {
    onTextDelta: (delta: string) => void;
    emittedTextLen: number;
    accumulatedText: string;
    conversationId?: string;
    resolve: (res: AgyTurnResult) => void;
    reject: (err: Error) => void;
  } | null = null;

  constructor(agyBin: string, modelId: string) {
    this.agyBin = agyBin;
    this.modelId = modelId;
  }

  isAlive(): boolean {
    return !this.closed && this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  canReuseFor(options: V4CallOptions): boolean {
    if (!this.isAlive() || this.sentMessageCount === 0) return false;
    const toolSig = extractFunctionTools(options)
      .map((t) => t.name)
      .join(',');
    if (toolSig !== this.lastToolSignature) return false;
    return options.prompt.length > this.sentMessageCount;
  }

  private ensureStarted(): void {
    if (this.isAlive()) return;
    if (this.closed) {
      throw new Error('agy worker has been disposed.');
    }

    const sandboxDir = getIsolatedAgySandboxDir();
    const child = spawn(
      this.agyBin,
      [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--model',
        this.modelId,
        '--sandbox',
        '--disable-slash-commands',
      ],
      {
        cwd: sandboxDir,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
      }
    );

    this.child = child;
    this.stdoutRemainder = '';
    this.stderrTail = '';
    this.sentMessageCount = 0;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });

    child.on('error', (err) => {
      const turn = this.activeTurn;
      this.activeTurn = null;
      this.child = null;
      if (turn) {
        turn.reject(new Error(`Failed to run agy CLI: ${err.message}`));
      }
    });

    child.on('exit', (code, signal) => {
      const turn = this.activeTurn;
      this.activeTurn = null;
      this.child = null;
      if (turn) {
        const hint = this.extractStderrHint();
        turn.reject(
          new Error(
            hint ||
              `agy CLI exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`
          )
        );
      }
    });
  }

  private extractStderrHint(): string {
    const lines = this.stderrTail
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^[IWEF]\d{4}\s/.test(l));
    if (lines.length === 0) return '';
    const joined = lines.slice(-3).join(' ');
    if (/not logged in|unauthenticated|login|auth/i.test(joined)) {
      return 'Antigravity CLI (`agy`) is not logged in. Run `agy acp --login` or click Sign in with agy in Settings.';
    }
    return joined.slice(0, 260);
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutRemainder += chunk;
    const lines = this.stdoutRemainder.split(/\r?\n/);
    this.stdoutRemainder = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('{')) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.handleNdjsonEvent(parsed);
    }
  }

  private handleNdjsonEvent(eventObj: Record<string, unknown>): void {
    const turn = this.activeTurn;
    if (!turn) return;

    const eventType = typeof eventObj.event === 'string' ? eventObj.event : '';

    if (eventType === 'init') {
      if (typeof eventObj.conversation_id === 'string') {
        turn.conversationId = eventObj.conversation_id;
      }
      return;
    }

    if (eventType === 'step_update') {
      const step = (
        eventObj.step_update && typeof eventObj.step_update === 'object'
          ? eventObj.step_update
          : eventObj
      ) as Record<string, unknown>;
      const stepType = typeof step.step_type === 'string' ? step.step_type : '';
      const delta = typeof step.text_delta === 'string' ? step.text_delta : '';

      if (stepType === 'agent_response' && delta.length > 0) {
        turn.emittedTextLen += delta.length;
        turn.accumulatedText += delta;
        turn.onTextDelta(delta);
      }
      return;
    }

    if (eventType === 'result') {
      const payload = (
        eventObj.result && typeof eventObj.result === 'object'
          ? eventObj.result
          : eventObj
      ) as Record<string, unknown>;
      const status = typeof payload.status === 'string' ? payload.status.toUpperCase() : 'SUCCESS';
      const responseText = typeof payload.response === 'string' ? payload.response : '';
      const rawUsage =
        payload.usage && typeof payload.usage === 'object'
          ? (payload.usage as AgyNdjsonUsage)
          : undefined;
      const conversationId =
        typeof payload.conversation_id === 'string'
          ? payload.conversation_id
          : turn.conversationId;

      this.activeTurn = null;

      if (status === 'ERROR' || status === 'CANCELED') {
        const errMsg =
          typeof payload.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            : typeof payload.message === 'string' && payload.message.trim()
              ? payload.message.trim()
              : this.extractStderrHint() || `agy returned status ${status}.`;
        turn.reject(new Error(errMsg));
        return;
      }

      // If no incremental step_update deltas arrived, emit the terminal response text
      if (turn.emittedTextLen === 0 && responseText) {
        turn.emittedTextLen = responseText.length;
        turn.accumulatedText = responseText;
        turn.onTextDelta(responseText);
      }

      turn.resolve({
        text: turn.accumulatedText || responseText,
        usage: mapAgyUsage(rawUsage),
        conversationId,
      });
    }
  }

  private bumpIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.dispose();
    }, WORKER_IDLE_TTL_MS);
    this.idleTimer.unref();
  }

  runTurn(
    options: V4CallOptions,
    callbacks: { onTextDelta: (delta: string) => void },
    oneShot = false
  ): Promise<AgyTurnResult> {
    const task = this.turnQueue.then(
      () => this.executeTurnInternal(options, callbacks, oneShot),
      () => this.executeTurnInternal(options, callbacks, oneShot)
    );
    this.turnQueue = task.catch(() => undefined);
    return task;
  }

  private executeTurnInternal(
    options: V4CallOptions,
    callbacks: { onTextDelta: (delta: string) => void },
    oneShot: boolean
  ): Promise<AgyTurnResult> {
    if (options.abortSignal?.aborted) {
      return Promise.reject(new Error('Request aborted.'));
    }

    const canReuse = !oneShot && this.canReuseFor(options);
    if (!canReuse && this.isAlive()) {
      this.killChild();
    }

    this.ensureStarted();

    const currentSystem = options.prompt
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const toolSig = extractFunctionTools(options)
      .map((t) => t.name)
      .join(',');

    let promptText: string;
    if (canReuse) {
      const deltaMessages = options.prompt.slice(this.sentMessageCount);
      const updatedSystem = currentSystem !== this.lastSystemText ? currentSystem : undefined;
      promptText = buildIncrementalPromptText(deltaMessages, updatedSystem);
    } else {
      promptText = buildFullPromptText(options);
    }

    return new Promise<AgyTurnResult>((resolve, reject) => {
      const onAbort = () => {
        const turn = this.activeTurn;
        this.activeTurn = null;
        this.killChild(true);
        if (turn) {
          turn.reject(new Error('agy request aborted.'));
        }
      };

      if (options.abortSignal) {
        options.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      const cleanup = () => {
        if (options.abortSignal) {
          options.abortSignal.removeEventListener('abort', onAbort);
        }
      };

      this.activeTurn = {
        onTextDelta: callbacks.onTextDelta,
        emittedTextLen: 0,
        accumulatedText: '',
        resolve: (res) => {
          cleanup();
          this.sentMessageCount = options.prompt.length;
          this.lastSystemText = currentSystem;
          this.lastToolSignature = toolSig;
          if (oneShot) {
            this.dispose();
          } else {
            this.bumpIdleTimer();
          }
          resolve(res);
        },
        reject: (err) => {
          cleanup();
          this.killChild();
          reject(err);
        },
      };

      try {
        const ndjsonLine = `${JSON.stringify({
          event: 'user',
          message: { content: promptText },
        })}\n`;
        // Keep stdin open until `result` arrives; closing stdin early cancels agy's stream input context.
        this.child?.stdin?.write(ndjsonLine, 'utf8');
      } catch (err) {
        const turn = this.activeTurn;
        this.activeTurn = null;
        cleanup();
        this.killChild();
        const message = err instanceof Error ? err.message : String(err);
        turn?.reject(new Error(`Failed to write prompt to agy CLI: ${message}`));
      }
    });
  }

  private killChild(forceImmediate = false): void {
    const child = this.child;
    this.child = null;
    this.sentMessageCount = 0;
    if (!child) return;

    try {
      child.stdin?.end();
    } catch {
      // Ignore
    }

    const terminate = () => {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore
        }
        setTimeout(() => {
          if (child.exitCode === null && !child.killed) {
            try {
              child.kill('SIGKILL');
            } catch {
              // Ignore
            }
          }
        }, 1500).unref();
      }
    };

    if (forceImmediate) {
      terminate();
    } else {
      // Allow agy a brief grace period to exit cleanly on stdin EOF after finishing a turn
      setTimeout(terminate, 500).unref();
    }
  }

  dispose(): void {
    this.closed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.killChild();
  }
}

// Session-scoped warm worker pool so multi-step tool calls & follow-up chat messages skip cold starts
const sessionWorkerPool = new Map<string, AgyStreamWorker>();

function getOrCreateSessionWorker(
  sessionKey: string,
  agyBin: string,
  modelId: string
): AgyStreamWorker {
  const existing = sessionWorkerPool.get(sessionKey);
  if (existing && existing.modelId === modelId && existing.isAlive()) {
    return existing;
  }
  if (existing) {
    existing.dispose();
    sessionWorkerPool.delete(sessionKey);
  }
  const fresh = new AgyStreamWorker(agyBin, modelId);
  sessionWorkerPool.set(sessionKey, fresh);
  return fresh;
}

export function disposeAgySessionWorker(sessionKey: string): void {
  const existing = sessionWorkerPool.get(sessionKey);
  if (existing) {
    existing.dispose();
    sessionWorkerPool.delete(sessionKey);
  }
}

export function disposeAllAgyWorkers(): void {
  for (const worker of sessionWorkerPool.values()) {
    worker.dispose();
  }
  sessionWorkerPool.clear();
  if (sharedSandboxDir) {
    try {
      fs.rmSync(sharedSandboxDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
    sharedSandboxDir = null;
  }
}

function ensureExitHooks(): void {
  if (exitHooksRegistered) return;
  exitHooksRegistered = true;
  process.once('exit', () => {
    disposeAllAgyWorkers();
  });
}

export interface CreateAgyLanguageModelOptions {
  modelId: string;
  sessionKey?: string;
}

/**
 * Creates a Vercel AI SDK `LanguageModelV4` backed by the local `agy` CLI (`stream-json`).
 * Zero credentials are read or persisted by Scavenger; auth is delegated to the user's `agy` login.
 */
export function createAgyLanguageModel(options: CreateAgyLanguageModelOptions): LanguageModel {
  const { modelId, sessionKey } = options;

  const requireAgyBin = (): string => {
    const bin = resolveAgyBinary();
    if (!bin) {
      throw new Error(
        'Antigravity CLI (`agy`) was not found on PATH. Install `agy`, sign in with `agy acp --login`, or switch providers in Settings.'
      );
    }
    return bin;
  };

  // Fallback per-model-instance worker for multi-step calls without an explicit sessionKey
  let instanceWorker: AgyStreamWorker | null = null;

  const acquireWorker = (oneShot: boolean): AgyStreamWorker => {
    const bin = requireAgyBin();
    if (oneShot) {
      return new AgyStreamWorker(bin, modelId);
    }
    if (sessionKey) {
      return getOrCreateSessionWorker(sessionKey, bin, modelId);
    }
    if (!instanceWorker || !instanceWorker.isAlive()) {
      instanceWorker = new AgyStreamWorker(bin, modelId);
    }
    return instanceWorker;
  };

  const model: V4LanguageModel = {
    specificationVersion: 'v4',
    provider: 'agy',
    modelId,
    supportedUrls: {},

    async doGenerate(callOptions: V4CallOptions): Promise<V4GenerateResult> {
      const worker = acquireWorker(true);
      const allowedTools = extractFunctionTools(callOptions).map((t) => t.name);
      const textChunks: string[] = [];
      const toolCalls: ParsedToolCall[] = [];

      const parser = new StreamingToolCallParser(allowedTools, {
        onText: (delta) => textChunks.push(delta),
        onToolCall: (call) => toolCalls.push(call),
      });

      const result = await worker.runTurn(
        callOptions,
        {
          onTextDelta: (delta) => parser.push(delta),
        },
        true
      );
      parser.flush();

      const content: V4Content[] = [];
      const combinedText = textChunks.join('');
      if (combinedText) {
        content.push({ type: 'text', text: combinedText });
      }
      for (const tc of toolCalls) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        });
      }

      return {
        content,
        finishReason:
          toolCalls.length > 0
            ? { unified: 'tool-calls', raw: 'tool_calls' }
            : { unified: 'stop', raw: 'stop' },
        usage: result.usage,
        response: {
          id: result.conversationId,
          modelId,
          timestamp: new Date(),
        },
        warnings: [],
      };
    },

    async doStream(callOptions: V4CallOptions): Promise<V4StreamResult> {
      const worker = acquireWorker(false);
      const allowedTools = extractFunctionTools(callOptions).map((t) => t.name);
      const textBlockId = `agy_txt_${crypto.randomUUID().slice(0, 8)}`;

      const stream = new ReadableStream<V4StreamPart>({
        start(controller) {
          let textStarted = false;
          let toolCallCount = 0;

          const ensureTextStarted = () => {
            if (!textStarted) {
              textStarted = true;
              controller.enqueue({ type: 'text-start', id: textBlockId });
            }
          };

          const closeTextIfOpen = () => {
            if (textStarted) {
              textStarted = false;
              controller.enqueue({ type: 'text-end', id: textBlockId });
            }
          };

          controller.enqueue({ type: 'stream-start', warnings: [] });

          const parser = new StreamingToolCallParser(allowedTools, {
            onText: (delta) => {
              ensureTextStarted();
              controller.enqueue({ type: 'text-delta', id: textBlockId, delta });
            },
            onToolCall: (tc) => {
              closeTextIfOpen();
              toolCallCount += 1;
              controller.enqueue({
                type: 'tool-call',
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                input: tc.input,
              });
            },
          });

          worker
            .runTurn(
              callOptions,
              {
                onTextDelta: (delta) => parser.push(delta),
              },
              false
            )
            .then((turnResult) => {
              parser.flush();
              closeTextIfOpen();
              controller.enqueue({
                type: 'response-metadata',
                id: turnResult.conversationId,
                modelId,
                timestamp: new Date(),
              });
              controller.enqueue({
                type: 'finish',
                usage: turnResult.usage,
                finishReason:
                  toolCallCount > 0
                    ? { unified: 'tool-calls', raw: 'tool_calls' }
                    : { unified: 'stop', raw: 'stop' },
              });
              // If no sessionKey was provided and this turn finished without tool calls, dispose temp worker
              if (!sessionKey && toolCallCount === 0 && instanceWorker) {
                instanceWorker.dispose();
                instanceWorker = null;
              }
              controller.close();
            })
            .catch((err) => {
              controller.enqueue({ type: 'error', error: err });
              controller.close();
            });
        },
      });

      return { stream };
    },
  };

  return model;
}
