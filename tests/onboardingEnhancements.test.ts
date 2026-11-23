import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownRenderer } from '../src/client/components/MarkdownRenderer.js';
import {
   parseCodeCitation,
  parseToolActivityTarget,
} from '../src/client/utils/citationParser.js';
import {
  computeArchitectureGraphLayout,
  computeBlastRadius,
  computeFlowHighlight,
} from '../src/client/utils/graphLayout.js';
import { createApp } from '../src/server/index.js';
import { resetKnowledgeCache } from '../src/server/knowledge/knowledgeStore.js';
import { resetSessionsCache } from '../src/server/session/sessionStore.js';
import type {
  CodePeekFileResponse,
  CodePeekGitResponse,
  HandbookExportResponse,
  KnowledgeGraphModuleNode,
  KnowledgeGraphResponse,
  RepoCoreFlow,
  RepoFileIndexEntry,
  SessionPublicState,
} from '../src/shared/types.js';

describe('3 Flagship Onboarding Enhancements (Code Peek, Architecture Graph Studio, Handbook Export)', () => {
  let tempSessionsDir: string;
  let tempKnowledgeDir: string;
  const origSessionsEnv = process.env.SCAVENGER_SESSIONS_DIR;
  const origKnowledgeEnv = process.env.SCAVENGER_KNOWLEDGE_DIR;

  beforeEach(async () => {
    tempSessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-enh-sess-'));
    tempKnowledgeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-enh-kb-'));
    process.env.SCAVENGER_SESSIONS_DIR = tempSessionsDir;
    process.env.SCAVENGER_KNOWLEDGE_DIR = tempKnowledgeDir;
    resetSessionsCache();
    resetKnowledgeCache();
  });

  afterEach(async () => {
    if (origSessionsEnv === undefined) {
      delete process.env.SCAVENGER_SESSIONS_DIR;
    } else {
      process.env.SCAVENGER_SESSIONS_DIR = origSessionsEnv;
    }
    if (origKnowledgeEnv === undefined) {
      delete process.env.SCAVENGER_KNOWLEDGE_DIR;
    } else {
      process.env.SCAVENGER_KNOWLEDGE_DIR = origKnowledgeEnv;
    }
    resetSessionsCache();
    resetKnowledgeCache();
    await fs.rm(tempSessionsDir, { recursive: true, force: true });
    await fs.rm(tempKnowledgeDir, { recursive: true, force: true });
  });

  describe('1. Citation Parser & Clickable Inline Citations', () => {
    it('parses file paths, line ranges, known files, and git SHAs while ignoring URLs and npm packages', () => {
      const colonRange = parseCodeCitation('src/server/guardrails/pathGuard.ts:42-88');
      expect(colonRange).toMatchObject({
        kind: 'file',
        path: 'src/server/guardrails/pathGuard.ts',
        highlightStart: 42,
        highlightEnd: 88,
      });
      expect(colonRange?.startLine).toBeLessThanOrEqual(42);
      expect(colonRange?.endLine).toBeGreaterThanOrEqual(88);

      const hashLine = parseCodeCitation('src/client/App.tsx#L15-L30');
      expect(hashLine).toMatchObject({
        kind: 'file',
        path: 'src/client/App.tsx',
        highlightStart: 15,
        highlightEnd: 30,
      });

      const knownBasename = parseCodeCitation('pathGuard.ts', {
        knownFiles: ['src/server/guardrails/pathGuard.ts'],
      });
      expect(knownBasename).toMatchObject({
        kind: 'file',
        path: 'src/server/guardrails/pathGuard.ts',
      });

      const commitSha = parseCodeCitation('a1b2c3d');
      expect(commitSha).toEqual({
        kind: 'git',
        commitSha: 'a1b2c3d',
        gitSubcommand: 'show',
      });

      // Negative cases: URLs, npm scoped packages, pure numbers, common hex words
      expect(parseCodeCitation('https://example.com/foo/bar.ts')).toBeNull();
      expect(parseCodeCitation('@ai-sdk/openai')).toBeNull();
      expect(parseCodeCitation('1234567')).toBeNull();
      expect(parseCodeCitation('deadbeef')).toBeNull();
    });

    it('parses tool activity items and renders clickable citation chips in MarkdownRenderer', () => {
      const readAct = parseToolActivityTarget({
        id: 'act_1',
        toolName: 'read_file',
        summary: 'Read src/server/index.ts (L10-45)',
        target: 'src/server/index.ts',
        status: 'completed',
      });
      expect(readAct).toMatchObject({
        kind: 'file',
        path: 'src/server/index.ts',
        highlightStart: 10,
        highlightEnd: 45,
      });

      const html = renderToStaticMarkup(
        createElement(MarkdownRenderer, {
          content: 'Inspect `src/server/guardrails/pathGuard.ts:15-40` and commit `7f3a9c1`.',
          onOpenCodePeek: () => {},
        })
      );
      expect(html).toContain('inline-citation-chip');
      expect(html).toContain('src/server/guardrails/pathGuard.ts:15-40');
    });
  });

  describe('2. Interactive Architecture Graph Layout & Blast Radius Engine', () => {
    const sampleModules: KnowledgeGraphModuleNode[] = [
      {
        id: 'server/routes',
        name: 'routes',
        path: 'src/server/routes',
        role: 'HTTP & SSE API routes',
        layer: 'api',
        files: ['src/server/routes/sessions.ts', 'src/server/routes/chat.ts'],
        dependsOnModules: ['server/agent', 'server/guardrails'],
        dependedOnByModules: ['server/entry'],
        keySymbols: ['sessionsRouter', 'chatRouter'],
        mastery: 'developing',
        observedFileCount: 2,
      },
      {
        id: 'server/entry',
        name: 'entry',
        path: 'src/server',
        role: 'Hono server entrypoint',
        layer: 'entry',
        files: ['src/server/index.ts'],
        dependsOnModules: ['server/routes'],
        dependedOnByModules: [],
        keySymbols: ['createApp'],
        mastery: 'solid',
        observedFileCount: 1,
      },
      {
        id: 'server/agent',
        name: 'agent',
        path: 'src/server/agent',
        role: 'Orchestrator & pedagogy loop',
        layer: 'core',
        files: ['src/server/agent/orchestrator.ts'],
        dependsOnModules: ['server/guardrails'],
        dependedOnByModules: ['server/routes'],
        keySymbols: ['runOnboardingTurn'],
        mastery: 'introduced',
        observedFileCount: 1,
      },
      {
        id: 'server/guardrails',
        name: 'guardrails',
        path: 'src/server/guardrails',
        role: 'Read-only path & git confinement',
        layer: 'guard',
        files: ['src/server/guardrails/pathGuard.ts', 'src/server/guardrails/gitGuard.ts'],
        dependsOnModules: [],
        dependedOnByModules: ['server/routes', 'server/agent'],
        keySymbols: ['validateRepoRoot', 'runReadOnlyGit'],
        mastery: 'solid',
        observedFileCount: 2,
      },
    ];

    it('lays out modules by architectural layer order and computes upstream/downstream blast radius', () => {
      const layout = computeArchitectureGraphLayout(sampleModules);
      expect(layout.nodes.length).toBe(4);
      expect(layout.edges.length).toBe(4);

      const entryNode = layout.nodes.find((n) => n.id === 'server/entry')!;
      const apiNode = layout.nodes.find((n) => n.id === 'server/routes')!;
      const coreNode = layout.nodes.find((n) => n.id === 'server/agent')!;
      const guardNode = layout.nodes.find((n) => n.id === 'server/guardrails')!;

      // Layer ordering from top to bottom: entry -> api -> core -> guard
      expect(entryNode.y).toBeLessThan(apiNode.y);
      expect(apiNode.y).toBeLessThan(coreNode.y);
      expect(coreNode.y).toBeLessThan(guardNode.y);

      for (const edge of layout.edges) {
        expect(edge.d).toMatch(/^M\s.*C\s/);
      }

      // Blast radius for server/guardrails (depended on by agent and routes, and transitively entry)
      const guardBlast = computeBlastRadius(sampleModules, 'server/guardrails');
      expect(guardBlast.directUpstream).toEqual(
        expect.arrayContaining(['server/routes', 'server/agent'])
      );
      expect(guardBlast.transitiveUpstream).toContain('server/entry');
      expect(guardBlast.directDownstream).toEqual([]);
      expect(guardBlast.affectedFilesCount).toBe(6);
      expect(guardBlast.riskLevel).toBe('high');

      // Core flow highlight
      const flow: RepoCoreFlow = {
        id: 'flow:chat',
        name: 'Chat Turn Flow',
        summary: 'Entry to routes to agent to guardrails',
        files: [
          'src/server/index.ts',
          'src/server/routes/chat.ts',
          'src/server/agent/orchestrator.ts',
          'src/server/guardrails/pathGuard.ts',
        ],
        steps: ['Receive request', 'Run agent', 'Enforce guardrails'],
      };
      const filesIndex: RepoFileIndexEntry[] = sampleModules.flatMap((m) =>
        m.files.map((f) => ({
          path: f,
          moduleId: m.id,
          language: 'typescript',
          lines: 100,
          sizeBytes: 2000,
          mtimeMs: 0,
          exports: [],
          imports: [],
        }))
      );
      const flowHighlight = computeFlowHighlight(flow, sampleModules, filesIndex);
      expect(flowHighlight.moduleIds).toEqual([
        'server/entry',
        'server/routes',
        'server/agent',
        'server/guardrails',
      ]);
      expect(flowHighlight.edgeIds).toContain('server/entry->server/routes');
      expect(flowHighlight.edgeIds).toContain('server/routes->server/agent');
      expect(flowHighlight.edgeIds).toContain('server/agent->server/guardrails');
    });
  });

  describe('3. Read-Only Peek, Knowledge Graph & Handbook Export Routes', () => {
    it('serves /peek/file, /peek/git, /knowledge/graph, and /export (HTML & Markdown) while enforcing pathGuard & gitGuard', async () => {
      const app = createApp();

      const createRes = await app.request('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoPath: process.cwd(),
          provider: { provider: 'demo', model: 'local-grounded-demo' },
        }),
      });
      expect(createRes.status).toBe(201);
      const { session } = (await createRes.json()) as { session: SessionPublicState };

      // 1. Peek file (valid slice + Knowledge Map enrichment)
      const peekFileRes = await app.request(
        `/api/sessions/${session.id}/peek/file?path=${encodeURIComponent('src/server/guardrails/pathGuard.ts')}&startLine=1&endLine=35`
      );
      expect(peekFileRes.status).toBe(200);
      const peekFile = (await peekFileRes.json()) as CodePeekFileResponse;
      expect(peekFile.path).toBe('src/server/guardrails/pathGuard.ts');
      expect(peekFile.language.toLowerCase()).toBe('typescript');
      expect(peekFile.lines.length).toBeGreaterThan(10);
      expect(peekFile.lines[0].lineNumber).toBe(1);
      expect(peekFile.exports.some((e) => e.name === 'validateRepoRoot')).toBe(true);
      expect(peekFile.importedByFiles.length).toBeGreaterThan(0);

      // 2. Peek file guardrail enforcement (blocks traversal and .git reads)
      const traversalRes = await app.request(
        `/api/sessions/${session.id}/peek/file?path=${encodeURIComponent('../../etc/passwd')}`
      );
      expect(traversalRes.status).toBe(400);

      const gitInternalRes = await app.request(
        `/api/sessions/${session.id}/peek/file?path=${encodeURIComponent('.git/config')}`
      );
      expect(gitInternalRes.status).toBe(400);

      // 3. Peek git (blame & show HEAD)
      const peekBlameRes = await app.request(
        `/api/sessions/${session.id}/peek/git?subcommand=blame&target=${encodeURIComponent('package.json')}&startLine=1&endLine=15`
      );
      expect(peekBlameRes.status).toBe(200);
      const peekBlame = (await peekBlameRes.json()) as CodePeekGitResponse;
      expect(peekBlame.isGitRepo).toBe(true);
      expect(peekBlame.subcommand).toBe('blame');
      expect(peekBlame.output).toContain('scavenger');

      const peekShowRes = await app.request(
        `/api/sessions/${session.id}/peek/git?subcommand=show&target=HEAD`
      );
      expect(peekShowRes.status).toBe(200);
      const peekShow = (await peekShowRes.json()) as CodePeekGitResponse;
      expect(peekShow.output).toContain('commit ');

      // 4. Knowledge Graph endpoint
      const graphRes = await app.request(`/api/sessions/${session.id}/knowledge/graph`);
      expect(graphRes.status).toBe(200);
      const graphData = (await graphRes.json()) as KnowledgeGraphResponse;
      expect(graphData.repoName).toBe('scavenger');
      expect(graphData.modules.length).toBeGreaterThan(0);
      expect(graphData.dependencyEdges.length).toBeGreaterThan(0);
      // Since we peeked pathGuard.ts above, its module should have observedFileCount >= 1
      const guardMod = graphData.modules.find((m) =>
        m.files.includes('src/server/guardrails/pathGuard.ts')
      );
      expect(guardMod?.observedFileCount).toBeGreaterThanOrEqual(1);

      // 5. Export Onboarding Handbook (HTML & Markdown)
      const htmlExportRes = await app.request(
        `/api/sessions/${session.id}/export?format=html`
      );
      expect(htmlExportRes.status).toBe(200);
      const htmlExport = (await htmlExportRes.json()) as HandbookExportResponse;
      expect(htmlExport.format).toBe('html');
      expect(htmlExport.filename).toBe('scavenger-onboarding-handbook.html');
      expect(htmlExport.mimeType).toContain('text/html');
      expect(htmlExport.content).toContain('<!DOCTYPE html>');
      expect(htmlExport.content).toContain('Architecture Module Directory');

      const mdExportRes = await app.request(
        `/api/sessions/${session.id}/export?format=md`
      );
      expect(mdExportRes.status).toBe(200);
      const mdExport = (await mdExportRes.json()) as HandbookExportResponse;
      expect(mdExport.format).toBe('md');
      expect(mdExport.filename).toBe('scavenger-onboarding-handbook.md');
      expect(mdExport.mimeType).toContain('text/markdown');
      expect(mdExport.content).toContain('# scavenger — Onboarding Handbook');
      expect(mdExport.content).toContain('## Architecture Module Directory');
    });
  });
});
