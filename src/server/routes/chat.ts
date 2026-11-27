import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ProviderSelection, SSEEvent } from '../../shared/types.js';
import { runOnboardingTurn } from '../agent/orchestrator.js';
import { getSession } from '../session/sessionStore.js';

const chatBodySchema = z.object({
  message: z.string().min(1, 'Message cannot be empty.').max(8000),
  provider: z
    .object({
      provider: z.enum(['agy', 'copilot', 'google', 'openai', 'anthropic', 'openai-compatible', 'demo']),
      model: z.string().optional(),
      baseUrl: z.string().optional(),
    })
    .optional(),
});

export const chatRouter = new Hono();

chatRouter.post('/:id/chat', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) {
    return c.json({ error: 'Session not found.' }, 404);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON request body.' }, 400);
  }

  const parsed = chatBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid chat request.' }, 400);
  }

  return streamSSE(c, async (stream) => {
    let writeQueue: Promise<void> = Promise.resolve();

    const emit = (event: SSEEvent) => {
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
      await runOnboardingTurn(
        session,
        parsed.data.message,
        emit,
        parsed.data.provider as ProviderSelection | undefined
      );
    } catch {
      // Error event already emitted by orchestrator
    } finally {
      // Ensure every queued SSE frame (including final `done` / `error`) flushes before closing
      await writeQueue;
    }
  });
});
