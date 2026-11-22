import { describe, expect, it } from 'vitest';
import type { SSEEvent } from '../src/shared/types.js';
import { createApp } from '../src/server/index.js';

describe('SSE chat streaming endpoint', () => {
  it('flushes all SSE events including the final done message before closing the stream', async () => {
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
    const { session } = (await createRes.json()) as { session: { id: string } };

    const chatRes = await app.request(`/api/sessions/${session.id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '1. low 2. learn the architecture 3. from conceptual to detail',
        provider: { provider: 'demo', model: 'local-grounded-demo' },
      }),
    });
    expect(chatRes.status).toBe(200);

    const rawStream = await chatRes.text();
    const events: SSEEvent[] = rawStream
      .replace(/\r\n/g, '\n')
      .split('\n\n')
      .map((frame) =>
        frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
      )
      .filter(Boolean)
      .map((payload) => JSON.parse(payload) as SSEEvent);

    const textDeltas = events.filter((e) => e.type === 'text-delta');
    const doneEvent = events.find((e) => e.type === 'done');

    expect(textDeltas.length).toBeGreaterThan(0);
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === 'done') {
      expect(doneEvent.message.role).toBe('assistant');
      expect(doneEvent.message.content.length).toBeGreaterThan(20);
      expect(doneEvent.message.stage).toBe(1);
    }
  });
});
