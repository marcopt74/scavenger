import { Hono } from 'hono';
import { z } from 'zod';
import { renderD2ToSvg } from '../tools/visualTools.js';

const d2Schema = z.object({
  source: z.string().min(1).max(20_000),
});

export const visualsRouter = new Hono();

visualsRouter.post('/d2', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = d2Schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: 'Invalid D2 diagram source.' }, 400);
    }

    const result = await renderD2ToSvg(parsed.data.source);
    return c.json(result, result.ok ? 200 : 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to render D2 diagram.';
    return c.json({ ok: false, error: message }, 500);
  }
});
