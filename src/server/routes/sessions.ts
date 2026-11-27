import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type {
  CodePeekFileResponse,
  CodePeekGitResponse,
  CodePeekLine,
  HandbookExportFormat,
  KnowledgeGraphModuleNode,
  KnowledgeGraphResponse,
  OnboardingStage,
  ProviderSelection,
  ScanSSEEvent,
  TopicMastery,
  UserLevel,
} from '../../shared/types.js';
import { disposeAgySessionWorker } from '../agyLanguageModel.js';
import {
  GuardrailViolationError,
  resolveSafeRepoPath,
  validateRepoRoot,
} from '../guardrails/pathGuard.js';
import { getRepoGitState } from '../knowledge/gitWatcher.js';
import { toKnowledgeBaseStatus } from '../knowledge/knowledgeStore.js';
import { scanOrRefreshRepoKnowledge } from '../knowledge/scannerAgent.js';
import {
  createSession,
  deleteSession,
  getRepoProgressSummaries,
  getSession,
  listSessionSummaries,
  saveSession,
  toPublicState,
  updateSessionCalibration,
  updateSessionKnowledge,
} from '../session/sessionStore.js';
import { readFileSlice } from '../tools/fsTools.js';
import { gitInspect } from '../tools/gitTools.js';

const providerSchema = z
  .object({
    provider: z.enum(['agy', 'copilot', 'google', 'openai', 'anthropic', 'openai-compatible', 'demo']),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
  })
  .optional();

const createSessionSchema = z.object({
  repoPath: z.string().min(1, 'Repository path is required.'),
  provider: providerSchema,
  forceFullScan: z.boolean().optional(),
  startFresh: z.boolean().optional(),
});

const patchSessionSchema = z.object({
  inferredLevel: z.enum(['uncalibrated', 'foundational', 'intermediate', 'advanced']).optional(),
  currentStage: z.number().int().min(0).max(4).optional(),
  provider: providerSchema,
});

const refreshKnowledgeSchema = z
  .object({
    mode: z.enum(['full', 'incremental']).optional(),
  })
  .optional();

export const sessionsRouter = new Hono();

sessionsRouter.get('/', (c) => {
  const repoPath = c.req.query('repoPath') || undefined;
  return c.json({
    sessions: listSessionSummaries(repoPath),
    repoProgress: getRepoProgressSummaries(),
  });
});

sessionsRouter.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createSessionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid request payload.' }, 400);
    }

    const provider = parsed.data.provider as ProviderSelection | undefined;
    const scanned = await scanOrRefreshRepoKnowledge(parsed.data.repoPath, {
      provider,
      forceFull: parsed.data.forceFullScan,
      skipLlmSynthesis: provider?.provider === 'demo',
    });

    const session = createSession(scanned.recon, provider, {
      knowledgeMap: scanned.knowledgeMap,
      knowledgeStatus: scanned.status,
      startFresh: parsed.data.startFresh,
    });
    return c.json({ session: toPublicState(session) }, 201);
  } catch (err) {
    if (err instanceof GuardrailViolationError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    const message = err instanceof Error ? err.message : 'Failed to initialize repository session.';
    return c.json({ error: message }, 500);
  }
});

sessionsRouter.post('/stream-init', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body.' }, 400);
  }

  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid request payload.' }, 400);
  }

  try {
    await validateRepoRoot(parsed.data.repoPath);
  } catch (err) {
    if (err instanceof GuardrailViolationError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    const message = err instanceof Error ? err.message : 'Invalid repository path.';
    return c.json({ error: message }, 400);
  }

  return streamSSE(c, async (stream) => {
    let writeQueue: Promise<void> = Promise.resolve();
    const emit = (event: ScanSSEEvent) => {
      writeQueue = writeQueue
        .then(() =>
          stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        )
        .catch(() => {
          // Client disconnected
        });
    };

    try {
      const provider = parsed.data.provider as ProviderSelection | undefined;
      const scanned = await scanOrRefreshRepoKnowledge(parsed.data.repoPath, {
        provider,
        forceFull: parsed.data.forceFullScan,
        skipLlmSynthesis: provider?.provider === 'demo',
        onProgress: (p) => {
          emit({
            type: 'scan-progress',
            phase: p.phase,
            message: p.message,
            percent: p.percent,
            filesProcessed: p.filesProcessed,
            totalFiles: p.totalFiles,
          });
        },
      });

      const session = createSession(scanned.recon, provider, {
        knowledgeMap: scanned.knowledgeMap,
        knowledgeStatus: scanned.status,
        startFresh: parsed.data.startFresh,
      });

      emit({
        type: 'scan-complete',
        session: toPublicState(session),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to scan repository knowledge base.';
      emit({
        type: 'scan-error',
        error: message,
      });
    } finally {
      await writeQueue;
    }
  });
});

sessionsRouter.get('/validate-path', async (c) => {
  const rawPath = c.req.query('path') || '';
  try {
    const canonical = await validateRepoRoot(rawPath);
    return c.json({ valid: true, canonicalPath: canonical });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid path.';
    return c.json({ valid: false, error: message }, 400);
  }
});

sessionsRouter.get('/:id', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) {
    return c.json({ error: 'Session not found.' }, 404);
  }
  return c.json({ session: toPublicState(session) });
});

sessionsRouter.delete('/:id', (c) => {
  const id = c.req.param('id');
  const deleted = deleteSession(id);
  if (!deleted) {
    return c.json({ error: 'Session not found.' }, 404);
  }
  disposeAgySessionWorker(id);
  return c.json({
    ok: true,
    sessions: listSessionSummaries(),
    repoProgress: getRepoProgressSummaries(),
  });
});

sessionsRouter.get('/:id/knowledge', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) {
    return c.json({ error: 'Session not found.' }, 404);
  }

  const autoRefresh = c.req.query('autoRefresh') !== 'false';
  try {
    const gitState = await getRepoGitState(session.repoPath);
    const currentHead = gitState.headCommit;
    const knownHead = session.knowledgeMap?.headCommit;

    if (knownHead && currentHead && knownHead !== currentHead) {
      if (autoRefresh) {
        const refreshed = await scanOrRefreshRepoKnowledge(session.repoPath, {
          recon: session.rootRecon,
          provider: session.provider,
          trigger: 'git-pull-auto',
          skipLlmSynthesis: session.provider.provider === 'demo',
        });
        updateSessionKnowledge(session, refreshed.knowledgeMap, refreshed.status);
        return c.json({
          session: toPublicState(session),
          knowledgeStatus: session.knowledgeStatus,
          refreshed: true,
          changedFilesCount: refreshed.changedFilesCount,
          commitsBehind: refreshed.commitsBehind,
        });
      }

      if (session.knowledgeMap) {
        session.knowledgeStatus = toKnowledgeBaseStatus(session.knowledgeMap, {
          state: 'stale',
          currentRepoHead: currentHead,
        });
        saveSession(session);
      }
    }

    return c.json({
      session: toPublicState(session),
      knowledgeStatus: session.knowledgeStatus,
      refreshed: false,
      changedFilesCount: 0,
      commitsBehind: 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to check knowledge status.';
    return c.json({ error: message }, 500);
  }
});

sessionsRouter.post('/:id/knowledge/refresh', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) {
    return c.json({ error: 'Session not found.' }, 404);
  }

  let rawBody: unknown = {};
  try {
    rawBody = await c.req.json();
  } catch {
    rawBody = {};
  }

  const parsed = refreshKnowledgeSchema.safeParse(rawBody);
  const mode = parsed.success ? (parsed.data?.mode ?? 'full') : 'full';

  try {
    const refreshed = await scanOrRefreshRepoKnowledge(session.repoPath, {
      recon: session.rootRecon,
      provider: session.provider,
      forceFull: mode === 'full',
      trigger: 'manual',
      skipLlmSynthesis: session.provider.provider === 'demo',
    });

    updateSessionKnowledge(session, refreshed.knowledgeMap, refreshed.status);
    return c.json({
      session: toPublicState(session),
      knowledgeStatus: refreshed.status,
      refreshed: true,
      changedFilesCount: refreshed.changedFilesCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to refresh knowledge base.';
    return c.json({ error: message }, 500);
  }
});

function parseNumberedSliceLines(
  content: string,
  startLine: number,
  isBinary: boolean
): CodePeekLine[] {
  if (isBinary || !content) {
    return [];
  }
  return content.split('\n').map((rawLine, idx) => {
    const match = rawLine.match(/^\s*(\d+)\s\|(?:\s(.*))?$/);
    if (match) {
      return {
        lineNumber: Number.parseInt(match[1], 10),
        text: match[2] ?? '',
      };
    }
    return {
      lineNumber: startLine + idx,
      text: rawLine,
    };
  });
}

function inferLanguageFromPath(filePath: string, indexedLanguage?: string): string {
  if (indexedLanguage && indexedLanguage.trim()) {
    return indexedLanguage;
  }
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.json':
      return 'json';
    case '.md':
    case '.mdx':
      return 'markdown';
    case '.css':
    case '.scss':
      return 'css';
    case '.html':
      return 'html';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.sh':
      return 'shell';
    default:
      return 'text';
  }
}

sessionsRouter.get('/:id/peek/file', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) {
    return c.json({ error: 'Session not found.' }, 404);
  }

  const rawPath = c.req.query('path') ?? '';
  if (!rawPath.trim()) {
    return c.json({ error: 'File path is required.' }, 400);
  }

  const parsedStart = Number.parseInt(c.req.query('startLine') ?? '', 10);
  const startLine = Number.isFinite(parsedStart) && parsedStart >= 1 ? parsedStart : 1;
  const parsedEnd = Number.parseInt(c.req.query('endLine') ?? '', 10);
  const endLine =
    Number.isFinite(parsedEnd) && parsedEnd >= startLine ? parsedEnd : startLine + 159;

  try {
    const slice = await readFileSlice(session.repoPath, {
      path: rawPath.trim(),
      startLine,
      endLine,
    });

    session.observedFiles.add(slice.path);
    saveSession(session);

    const lines = parseNumberedSliceLines(slice.content, slice.startLine, slice.isBinary);
    const fileEntry = session.knowledgeMap?.files.find((f) => f.path === slice.path);
    const moduleEntry = session.knowledgeMap?.modules.find(
      (m) => m.id === fileEntry?.moduleId
    );
    const edges = session.knowledgeMap?.dependencyEdges ?? [];
    const importedByFiles = [
      ...new Set(edges.filter((e) => e.to === slice.path).map((e) => e.from)),
    ];
    const importsRepoFiles = [
      ...new Set(edges.filter((e) => e.from === slice.path).map((e) => e.to)),
    ];

    const response: CodePeekFileResponse = {
      path: slice.path,
      language: inferLanguageFromPath(slice.path, fileEntry?.language),
      startLine: slice.startLine,
      endLine: slice.endLine,
      totalLines: slice.totalLines,
      truncated: slice.truncated,
      isBinary: slice.isBinary,
      content: slice.content,
      lines,
      moduleId: fileEntry?.moduleId ?? moduleEntry?.id,
      moduleLayer: moduleEntry?.layer,
      roleSummary: fileEntry?.roleSummary,
      isEntryPoint: fileEntry?.isEntryPoint,
      exports: fileEntry?.exports ?? [],
      importedByFiles,
      importsRepoFiles,
    };

    return c.json(response);
  } catch (err) {
    if (err instanceof GuardrailViolationError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    const message = err instanceof Error ? err.message : 'Failed to inspect file.';
    return c.json({ error: message }, 400);
  }
});

sessionsRouter.get('/:id/peek/git', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) {
    return c.json({ error: 'Session not found.' }, 404);
  }

  const rawSubcommand = (c.req.query('subcommand') ?? 'show').trim();
  if (rawSubcommand !== 'show' && rawSubcommand !== 'blame' && rawSubcommand !== 'log') {
    return c.json(
      { error: `Unsupported git peek subcommand "${rawSubcommand}". Allowed: show, blame, log.` },
      400
    );
  }

  const subcommand: 'show' | 'blame' | 'log' = rawSubcommand;
  const rawTarget = (c.req.query('target') ?? '').trim();

  try {
    let args: string[];
    let resolvedTarget: string;

    if (subcommand === 'show') {
      if (!rawTarget || (rawTarget !== 'HEAD' && !/^[0-9a-fA-F]{4,40}$/.test(rawTarget))) {
        return c.json(
          { error: 'Valid commit SHA (4-40 hex characters) or HEAD is required for git show.' },
          400
        );
      }
      args = ['--stat', '--patch', rawTarget];
      resolvedTarget = rawTarget;
    } else if (subcommand === 'blame') {
      if (!rawTarget) {
        return c.json({ error: 'File path target is required for git blame.' }, 400);
      }
      const safe = await resolveSafeRepoPath(session.repoPath, rawTarget);
      const parsedStart = Number.parseInt(c.req.query('startLine') ?? '', 10);
      const start = Number.isFinite(parsedStart) && parsedStart >= 1 ? parsedStart : 1;
      const parsedEnd = Number.parseInt(c.req.query('endLine') ?? '', 10);
      const requestedEnd =
        Number.isFinite(parsedEnd) && parsedEnd >= start ? parsedEnd : start + 119;
      const end = Math.min(requestedEnd, start + 249);
      args = ['-L', `${start},${end}`, '--', safe.relativePath];
      resolvedTarget = safe.relativePath;
    } else {
      if (rawTarget) {
        const safe = await resolveSafeRepoPath(session.repoPath, rawTarget);
        args = ['-n', '12', '--oneline', '--', safe.relativePath];
        resolvedTarget = safe.relativePath;
      } else {
        args = ['-n', '15', '--oneline'];
        resolvedTarget = 'HEAD';
      }
    }

    const result = await gitInspect(session.repoPath, {
      subcommand,
      args,
    });

    if (subcommand === 'show' && rawTarget !== 'HEAD') {
      session.observedCommits.add(rawTarget);
    }
    for (const sha of result.observedCommits) {
      session.observedCommits.add(sha);
    }
    saveSession(session);

    const response: CodePeekGitResponse = {
      isGitRepo: result.isGitRepo,
      subcommand,
      target: resolvedTarget || 'HEAD',
      command: result.command,
      output: result.output,
      truncated: result.truncated,
      observedCommits: result.observedCommits,
    };

    return c.json(response);
  } catch (err) {
    if (err instanceof GuardrailViolationError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    const message = err instanceof Error ? err.message : 'Failed to inspect git history.';
    return c.json({ error: message }, 400);
  }
});

sessionsRouter.get('/:id/knowledge/graph', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) {
    return c.json({ error: 'Session not found.' }, 404);
  }

  try {
    if (!session.knowledgeMap) {
      const scanned = await scanOrRefreshRepoKnowledge(session.repoPath, {
        recon: session.rootRecon,
        provider: session.provider,
        skipLlmSynthesis: true,
      });
      updateSessionKnowledge(session, scanned.knowledgeMap, scanned.status);
    }

    const km = session.knowledgeMap!;
    const topics = session.learning.topics;

    const modules: KnowledgeGraphModuleNode[] = km.modules.map((m) => {
      const observedFileCount = m.files.filter((filePath) =>
        session.observedFiles.has(filePath)
      ).length;

      const moduleFilesSet = new Set(m.files);
      const matchedTopic = topics.find((t) => {
        if (t.id.toLowerCase().includes(m.id.toLowerCase())) return true;
        if (m.name && t.title.toLowerCase().includes(m.name.toLowerCase())) return true;
        if (t.relatedFiles?.some((rf) => moduleFilesSet.has(rf))) return true;
        return false;
      });

      let mastery: TopicMastery = 'unexplored';
      if (matchedTopic && matchedTopic.mastery !== 'unexplored') {
        mastery = matchedTopic.mastery;
      } else if (observedFileCount > 0) {
        mastery = 'introduced';
      } else if (matchedTopic) {
        mastery = matchedTopic.mastery;
      }

      return {
        ...m,
        mastery,
        observedFileCount,
        relatedTopicId: matchedTopic?.id,
        relatedTopicTitle: matchedTopic?.title,
      };
    });

    const response: KnowledgeGraphResponse = {
      repoName: km.repoName,
      repoPath: km.repoPath,
      headCommit: km.headCommit,
      branch: km.branch,
      scannedAt: km.scannedAt,
      updatedAt: km.updatedAt,
      scanStrategy: km.scanStrategy,
      stats: km.stats,
      summary: km.summary,
      modules,
      files: km.files,
      dependencyEdges: km.dependencyEdges,
    };

    return c.json(response);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to build knowledge graph.';
    return c.json({ error: message }, 500);
  }
});

sessionsRouter.get('/:id/export', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) {
    return c.json({ error: 'Session not found.' }, 404);
  }

  const rawFormat = (c.req.query('format') ?? 'html').trim().toLowerCase();
  const format: HandbookExportFormat = rawFormat === 'md' ? 'md' : 'html';

  try {
    const { generateSessionHandbook } = await import('../session/handbookGenerator.js');
    const handbook = await generateSessionHandbook(session, format);
    return c.json(handbook);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to export onboarding handbook.';
    return c.json({ error: message }, 500);
  }
});

sessionsRouter.patch('/:id', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) {
    return c.json({ error: 'Session not found.' }, 404);
  }

  try {
    const body = await c.req.json();
    const parsed = patchSessionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid patch payload.' }, 400);
    }

    updateSessionCalibration(session, {
      inferredLevel: parsed.data.inferredLevel as UserLevel | undefined,
      currentStage: parsed.data.currentStage as OnboardingStage | undefined,
      provider: parsed.data.provider as ProviderSelection | undefined,
    });

    return c.json({ session: toPublicState(session) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update session.';
    return c.json({ error: message }, 400);
  }
});
