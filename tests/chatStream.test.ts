import { describe, expect, it } from 'vitest';
import type { SSEEvent } from '../src/shared/types.js';
import { createApp } from '../src/server/index.js';

describe('SSE chat streaming endpoint', () => {
  it('flushes all SSE events including learning state, check-in questions, next steps, and final done message', async () => {
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
        message: 'Teach me about pathGuard',
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
    const stateEvents = events.filter((e) => e.type === 'session-state');
    const doneEvent = events.find((e) => e.type === 'done');

    expect(textDeltas.length).toBeGreaterThan(0);
    expect(stateEvents.length).toBeGreaterThan(0);

    const latestState = stateEvents[stateEvents.length - 1];
    if (latestState && latestState.type === 'session-state') {
      expect(latestState.learning.activeTopicId).toBe('custom:pathguard');
      expect(latestState.learning.pendingCheckIn.length).toBeGreaterThanOrEqual(1);
      expect(latestState.learning.pendingCheckIn.length).toBeLessThanOrEqual(3);
      expect(latestState.learning.suggestedNextSteps.length).toBeGreaterThanOrEqual(2);
      expect(latestState.learning.suggestedNextSteps.length).toBeLessThanOrEqual(3);
    }

    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === 'done') {
      expect(doneEvent.message.role).toBe('assistant');
      expect(doneEvent.message.topicTitle).toBe('PathGuard');
      expect(doneEvent.message.content).toContain('pathGuard.ts');
      expect(doneEvent.message.checkInQuestions?.length).toBeGreaterThanOrEqual(1);
      expect(doneEvent.message.suggestedNextSteps?.length).toBeGreaterThanOrEqual(2);
    }
  });
});
