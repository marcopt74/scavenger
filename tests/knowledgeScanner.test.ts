import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScanSSEEvent, SessionPublicState } from '../src/shared/types.js';
import { buildSystemPrompt } from '../src/server/agent/systemPrompt.js';
import { DEFAULT_IGNORED_DIRS } from '../src/server/guardrails/pathGuard.js';
import { createApp } from '../src/server/index.js';
import {
  ensureKnowledgeDirSync,
  getKnowledgeFilePath,
  loadKnowledgeMap,
  resetKnowledgeCache,
} from '../src/server/knowledge/knowledgeStore.js';
import {
  queryKnowledgeMap,
  scanOrRefreshRepoKnowledge,
} from '../src/server/knowledge/scannerAgent.js';
import { createSession } from '../src/server/session/sessionStore.js';

const execFileAsync = promisify(execFile);

describe('Pre-onboarding Repo Scanner Agent & Persistent Knowledge Base', () => {
  let tempKnowledgeDir: string;
  let tempRepoDir: string;
  const originalKnowledgeEnv = process.env.SCAVENGER_KNOWLEDGE_DIR;

  beforeEach(async () => {
    tempKnowledgeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-kb-test-'));
    tempRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-sample-repo-'));
    process.env.SCAVENGER_KNOWLEDGE_DIR = tempKnowledgeDir;
    resetKnowledgeCache();
  });

  afterEach(async () => {
    if (originalKnowledgeEnv === undefined) {
      delete process.env.SCAVENGER_KNOWLEDGE_DIR;
    } else {
      process.env.SCAVENGER_KNOWLEDGE_DIR = originalKnowledgeEnv;
    }
    resetKnowledgeCache();
    await fs.rm(tempKnowledgeDir, { recursive: true, force: true });
    await fs.rm(tempRepoDir, { recursive: true, force: true });
  });

  it('guarantees knowledge folders are ignored by Git and never committed', async () => {
    const initializedDir = ensureKnowledgeDirSync();
    const innerGitignore = await fs.readFile(path.join(initializedDir, '.gitignore'), 'utf8');
    expect(innerGitignore).toContain('*');
    expect(innerGitignore).toContain('!.gitignore');

    expect(DEFAULT_IGNORED_DIRS.has('.scavenger')).toBe(true);
    expect(DEFAULT_IGNORED_DIRS.has('.scavenger-knowledge')).toBe(true);

    // Verify repo root .gitignore blocks knowledge directories and files from git tracking
    const repoRoot = process.cwd();
    const candidates = [
      '.scavenger/knowledge/sample.json',
      '.scavenger-knowledge/sample.json',
      'knowledge/repo-123.json',
      'knowledge-map.json',
    ];

    for (const candidate of candidates) {
      const { stdout } = await execFileAsync('git', ['check-ignore', candidate], {
        cwd: repoRoot,
      });
      expect(stdout.trim()).toBe(candidate);
    }
  });

  it('indexes modules, exported symbols, and cross-file dependencies and persists outside target repo', async () => {
    await fs.mkdir(path.join(tempRepoDir, 'src', 'core'), { recursive: true });
    await fs.mkdir(path.join(tempRepoDir, 'src', 'api'), { recursive: true });

    await fs.writeFile(
      path.join(tempRepoDir, 'package.json'),
      JSON.stringify({ name: 'demo-service', version: '1.0.0' }, null, 2),
      'utf8'
    );
    await fs.writeFile(
      path.join(tempRepoDir, 'README.md'),
      '# Demo Service\n\nA lightweight order processing API.\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(tempRepoDir, 'src', 'core', 'engine.ts'),
      [
        'export interface OrderItem { id: string; qty: number; }',
        'export function calculateTotal(items: OrderItem[]): number {',
        '  return items.reduce((sum, item) => sum + item.qty, 0);',
        '}',
      ].join('\n'),
      'utf8'
    );
    await fs.writeFile(
      path.join(tempRepoDir, 'src', 'api', 'index.ts'),
      [
        "import { calculateTotal } from '../core/engine.js';",
        'export function handleOrderRequest() {',
        '  return calculateTotal([{ id: "a", qty: 2 }]);',
        '}',
      ].join('\n'),
      'utf8'
    );

    const result = await scanOrRefreshRepoKnowledge(tempRepoDir, {
      provider: { provider: 'demo', model: 'local-grounded-demo' },
      skipLlmSynthesis: true,
    });

    expect(result.refreshed).toBe(true);
    expect(result.knowledgeMap.stats.indexedFiles).toBe(4);
    expect(result.knowledgeMap.stats.totalSymbols).toBeGreaterThanOrEqual(3);
    expect(result.knowledgeMap.stats.totalEdges).toBe(1);

    // Ensure target repo was not mutated with any knowledge files
    const repoEntries = await fs.readdir(tempRepoDir);
    expect(repoEntries.sort()).toEqual(['README.md', 'package.json', 'src']);

    // Ensure knowledge map was persisted in SCAVENGER_KNOWLEDGE_DIR with 0600 permissions
    const persistedPath = getKnowledgeFilePath(result.knowledgeMap.repoPath);
    const stat = await fs.stat(persistedPath);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }

    const loaded = loadKnowledgeMap(result.knowledgeMap.repoPath);
    expect(loaded).not.toBeNull();
    expect(loaded?.repoName).toBe(result.knowledgeMap.repoName);

    // Test queryKnowledgeMap lookups
    const symLookup = queryKnowledgeMap(result.knowledgeMap, {
      queryType: 'symbol',
      target: 'calculateTotal',
    });
    expect(symLookup).toHaveProperty('matchCount', 1);

    const depLookup = queryKnowledgeMap(result.knowledgeMap, {
      queryType: 'dependents',
      target: 'engine.ts',
    });
    expect(depLookup).toHaveProperty('dependedOnBy');

    // Verify system prompt includes Knowledge Map digest
    const session = createSession(
      result.recon,
      { provider: 'demo', model: 'local-grounded-demo' },
      { knowledgeMap: result.knowledgeMap, knowledgeStatus: result.status }
    );
    const systemPrompt = buildSystemPrompt(session, { d2Available: false });
    expect(systemPrompt).toContain('Pre-Scanned Repository Knowledge Map');
    expect(systemPrompt).toContain('calculateTotal');
  });

  it('auto-detects git HEAD updates (e.g. git pull) and incrementally refreshes changed files', async () => {
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };

    await execFileAsync('git', ['init'], { cwd: tempRepoDir, env: gitEnv });
    await fs.mkdir(path.join(tempRepoDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tempRepoDir, 'src', 'math.ts'),
      'export function add(a: number, b: number) { return a + b; }\n',
      'utf8'
    );
    await execFileAsync('git', ['add', '.'], { cwd: tempRepoDir, env: gitEnv });
    await execFileAsync('git', ['commit', '-m', 'Initial commit'], {
      cwd: tempRepoDir,
      env: gitEnv,
    });

    // 1. Initial scan
    const initial = await scanOrRefreshRepoKnowledge(tempRepoDir, {
      provider: { provider: 'demo', model: 'local-grounded-demo' },
      skipLlmSynthesis: true,
    });
    expect(initial.refreshed).toBe(true);
    expect(initial.trigger).toBe('initial');
    expect(initial.knowledgeMap.headCommit).toBeTruthy();

    // 2. Second call without git changes hits cache
    const cachedHit = await scanOrRefreshRepoKnowledge(tempRepoDir, {
      provider: { provider: 'demo', model: 'local-grounded-demo' },
      skipLlmSynthesis: true,
    });
    expect(cachedHit.refreshed).toBe(false);
    expect(cachedHit.trigger).toBe('cached');

    // 3. Simulate a git pull / new commit adding a file and modifying math.ts
    await fs.writeFile(
      path.join(tempRepoDir, 'src', 'math.ts'),
      [
        'export function add(a: number, b: number) { return a + b; }',
        'export function multiply(a: number, b: number) { return a * b; }',
      ].join('\n'),
      'utf8'
    );
    await fs.writeFile(
      path.join(tempRepoDir, 'src', 'formatter.ts'),
      'export function formatCurrency(n: number) { return `$${n.toFixed(2)}`; }\n',
      'utf8'
    );
    await execFileAsync('git', ['add', '.'], { cwd: tempRepoDir, env: gitEnv });
    await execFileAsync('git', ['commit', '-m', 'Pull new math and formatter functions'], {
      cwd: tempRepoDir,
      env: gitEnv,
    });

    // 4. Subsequent scan detects git HEAD change and incrementally refreshes
    const incremental = await scanOrRefreshRepoKnowledge(tempRepoDir, {
      provider: { provider: 'demo', model: 'local-grounded-demo' },
      skipLlmSynthesis: true,
    });
    expect(incremental.refreshed).toBe(true);
    expect(incremental.trigger).toBe('git-pull-auto');
    expect(incremental.changedFilesCount).toBe(2);
    expect(incremental.knowledgeMap.headCommit).not.toBe(initial.knowledgeMap.headCommit);

    const symRes = queryKnowledgeMap(incremental.knowledgeMap, {
      queryType: 'symbol',
      target: 'formatCurrency',
    });
    expect(symRes).toHaveProperty('matchCount', 1);
  });

  it('streams scan progress on /api/sessions/stream-init and supports on-demand refresh', async () => {
    const app = createApp();

    await fs.mkdir(path.join(tempRepoDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tempRepoDir, 'src', 'index.ts'),
      'export function bootServer() { return true; }\n',
      'utf8'
    );

    const streamRes = await app.request('/api/sessions/stream-init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: tempRepoDir,
        provider: { provider: 'demo', model: 'local-grounded-demo' },
      }),
    });
    expect(streamRes.status).toBe(200);

    const rawText = await streamRes.text();
    const events: ScanSSEEvent[] = rawText
      .replace(/\r\n/g, '\n')
      .split('\n\n')
      .map((frame) =>
        frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n')
      )
      .filter(Boolean)
      .map((payload) => JSON.parse(payload) as ScanSSEEvent);

    const progressEvents = events.filter((e) => e.type === 'scan-progress');
    const completeEvent = events.find((e) => e.type === 'scan-complete');

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(completeEvent).toBeDefined();
    if (!completeEvent || completeEvent.type !== 'scan-complete') {
      throw new Error('Expected scan-complete event');
    }

    const sessionId = completeEvent.session.id;
    expect(completeEvent.session.knowledgeStatus?.state).toBe('ready');
    expect(completeEvent.session.knowledgeStatus?.stats?.indexedFiles).toBe(1);

    // Add a new file and trigger manual on-demand refresh via POST /api/sessions/:id/knowledge/refresh
    await fs.writeFile(
      path.join(tempRepoDir, 'src', 'extra.ts'),
      'export const EXTRA_FLAG = true;\n',
      'utf8'
    );

    const refreshRes = await app.request(`/api/sessions/${sessionId}/knowledge/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'full' }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshJson = (await refreshRes.json()) as {
      session: SessionPublicState;
      refreshed: boolean;
    };
    expect(refreshJson.refreshed).toBe(true);
    expect(refreshJson.session.knowledgeStatus?.stats?.indexedFiles).toBe(2);
    expect(refreshJson.session.knowledgeStatus?.lastRefreshTrigger).toBe('manual');
  });
});
