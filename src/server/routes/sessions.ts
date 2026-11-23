import { Hono } from 'hono';
import { z } from 'zod';
import type { OnboardingStage, ProviderSelection, UserLevel } from '../../shared/types.js';
import { GuardrailViolationError, validateRepoRoot } from '../guardrails/pathGuard.js';
import {
  createSession,
  getSession,
  toPublicState,
  updateSessionCalibration,
} from '../session/sessionStore.js';
import { runRootRecon } from '../tools/rootRecon.js';

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
});

const patchSessionSchema = z.object({
  inferredLevel: z.enum(['uncalibrated', 'foundational', 'intermediate', 'advanced']).optional(),
  currentStage: z.number().int().min(0).max(4).optional(),
  provider: providerSchema,
});

export const sessionsRouter = new Hono();

sessionsRouter.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createSessionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid request payload.' }, 400);
    }

    const rootRecon = await runRootRecon(parsed.data.repoPath);
    const session = createSession(rootRecon, parsed.data.provider as ProviderSelection | undefined);
    return c.json({ session: toPublicState(session) }, 201);
  } catch (err) {
    if (err instanceof GuardrailViolationError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    const message = err instanceof Error ? err.message : 'Failed to initialize repository session.';
    return c.json({ error: message }, 500);
  }
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
