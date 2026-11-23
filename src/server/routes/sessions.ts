import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type {
  OnboardingStage,
  ProviderSelection,
  ScanSSEEvent,
  UserLevel,
} from '../../shared/types.js';
import { GuardrailViolationError, validateRepoRoot } from '../guardrails/pathGuard.js';
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

const providerSchema = z
  .object({
    provider: z.enum(['copilot', 'google', 'openai', 'anthropic', 'openai-compatible', 'demo']),
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
