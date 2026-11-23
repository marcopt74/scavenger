import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  SessionPublicState,
  SessionsListResponse,
} from '../src/shared/types.js';
import { createApp } from '../src/server/index.js';
import { resetKnowledgeCache } from '../src/server/knowledge/knowledgeStore.js';
import {
  ensureSessionsDirSync,
  resetSessionsCache,
} from '../src/server/session/sessionStore.js';

describe('Session Persistence, Refresh Recovery & Cross-Session Progress', () => {
  let tempSessionsDir: string;
  let tempKnowledgeDir: string;
  const origSessionsEnv = process.env.SCAVENGER_SESSIONS_DIR;
  const origKnowledgeEnv = process.env.SCAVENGER_KNOWLEDGE_DIR;

  beforeEach(async () => {
    tempSessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-sessions-test-'));
    tempKnowledgeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-kb-sess-test-'));
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

  it('persists sessions on disk with .gitignore protection and restores state after cache reset', async () => {
    const dir = ensureSessionsDirSync();
    const gitignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('*');
    expect(gitignore).toContain('!.gitignore');

    const app = createApp();

    // 1. Start session
    const createRes = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: process.cwd(),
        provider: { provider: 'demo', model: 'local-grounded-demo' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { session: created } = (await createRes.json()) as { session: SessionPublicState };
    expect(created.messages.length).toBe(1);

    // 2. Run a chat turn to evolve learning state and messages
    const chatRes = await app.request(`/api/sessions/${created.id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: "I'm a senior engineer. Let's explore System Architecture.",
        provider: { provider: 'demo', model: 'local-grounded-demo' },
      }),
    });
    expect(chatRes.status).toBe(200);
    await chatRes.text();

    // 3. Simulate server restart + browser refresh by clearing in-memory cache and fetching GET /api/sessions/:id
    resetSessionsCache();

    const getRes = await app.request(`/api/sessions/${created.id}`);
    expect(getRes.status).toBe(200);
    const { session: restored } = (await getRes.json()) as { session: SessionPublicState };

    expect(restored.id).toBe(created.id);
    expect(restored.messages.length).toBe(3);
    expect(restored.diagnostic.completed).toBe(true);
    expect(restored.diagnostic.inferredLevel).toBe('advanced');
    expect(restored.currentStage).toBe(2);
    expect(restored.learning.activeTopicId).toBe('pillar:architecture');
  });

  it('carries over topic mastery and calibration across sessions for the same repo unless startFresh is true', async () => {
    const app = createApp();

    // Session 1: Calibrate to advanced and explore System Architecture + custom topic pathGuard
    const res1 = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: process.cwd(),
        provider: { provider: 'demo', model: 'local-grounded-demo' },
      }),
    });
    const { session: s1 } = (await res1.json()) as { session: SessionPublicState };

    const turn1 = await app.request(`/api/sessions/${s1.id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'I am an advanced architect. Teach me about pathGuard.',
        provider: { provider: 'demo', model: 'local-grounded-demo' },
      }),
    });
    await turn1.text();

    // Session 2 (default carry-over): Should inherit advanced calibration, completed stage 0, and custom:pathguard topic
    const res2 = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: process.cwd(),
        provider: { provider: 'demo', model: 'local-grounded-demo' },
      }),
    });
    expect(res2.status).toBe(201);
    const { session: s2 } = (await res2.json()) as { session: SessionPublicState };

    expect(s2.id).not.toBe(s1.id);
    expect(s2.diagnostic.completed).toBe(true);
    expect(s2.diagnostic.inferredLevel).toBe('advanced');
    expect(s2.completedStages).toContain(0);
    expect(s2.learning.topics.some((t) => t.id === 'custom:pathguard')).toBe(true);
    expect(s2.messages[0]?.content).toContain('Cross-Session Progress Restored');

    // Session 3 (startFresh: true): Should start clean without prior calibration or custom topics
    const res3 = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: process.cwd(),
        provider: { provider: 'demo', model: 'local-grounded-demo' },
        startFresh: true,
      }),
    });
    expect(res3.status).toBe(201);
    const { session: s3 } = (await res3.json()) as { session: SessionPublicState };

    expect(s3.diagnostic.completed).toBe(false);
    expect(s3.diagnostic.inferredLevel).toBe('uncalibrated');
    expect(s3.learning.topics.some((t) => t.id === 'custom:pathguard')).toBe(false);

    // Verify GET /api/sessions returns all 3 sessions and aggregated repoProgress
    const listRes = await app.request('/api/sessions');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as SessionsListResponse;
    expect(listBody.sessions.length).toBe(3);
    expect(listBody.repoProgress.length).toBe(1);

    const repoProg = listBody.repoProgress[0]!;
    expect(repoProg.sessionCount).toBe(3);
    expect(repoProg.pillarMasteries.recon).toBe('solid');
    expect(repoProg.topics.some((t) => t.id === 'custom:pathguard')).toBe(true);
    expect(repoProg.progressPercent).toBeGreaterThan(10);

    // Verify DELETE /api/sessions/:id removes a session cleanly
    const delRes = await app.request(`/api/sessions/${s3.id}`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as SessionsListResponse & { ok: boolean };
    expect(delBody.ok).toBe(true);
    expect(delBody.sessions.length).toBe(2);
    expect(delBody.repoProgress[0]?.sessionCount).toBe(2);
  });
});
