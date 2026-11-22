import { describe, expect, it } from 'vitest';
import type { RootReconSummary } from '../src/shared/types.js';
import {
  assessCheckInResponse,
  createInitialLearningState,
  detectCustomTopicRequest,
  detectPillarRequest,
  setCheckInQuestions,
  setSuggestedNextSteps,
  upsertTopicMastery,
} from '../src/server/session/learningEngine.js';

const MOCK_RECON: RootReconSummary = {
  repoName: 'sample-app',
  repoPath: '/tmp/sample-app',
  isGitRepo: true,
  topLevelTree: 'sample-app/\n├── src/\n└── package.json',
  topLevelEntries: [
    { name: 'src', type: 'dir' },
    { name: 'package.json', type: 'file' },
  ],
  manifests: [{ path: 'package.json', kind: 'Node / JS manifest', excerpt: '{}' }],
  recentMilestones: [],
  recentTags: [],
  topContributors: [],
  detectedStack: ['TypeScript'],
  inspectedAt: new Date().toISOString(),
};

describe('learningEngine (non-linear mastery, check-ins, custom topics & next steps)', () => {
  it('initializes all 5 core pillars and 3 starter suggested next steps', () => {
    const state = createInitialLearningState(MOCK_RECON);
    expect(state.topics).toHaveLength(5);
    expect(state.activeTopicId).toBe('pillar:recon');
    expect(state.topics.find((t) => t.pillarId === 'recon')?.mastery).toBe('introduced');
    expect(state.topics.find((t) => t.pillarId === 'architecture')?.mastery).toBe('unexplored');
    expect(state.suggestedNextSteps).toHaveLength(3);
  });

  it('registers custom topics dynamically and supports bidirectional mastery evolution', () => {
    const state = createInitialLearningState(MOCK_RECON);

    const created = upsertTopicMastery(state, {
      title: 'SSE Streaming',
      kind: 'custom',
      mastery: 'introduced',
      relatedFiles: ['src/server/routes/chat.ts'],
    });
    expect(created.id).toBe('custom:sse-streaming');
    expect(state.activeTopicId).toBe('custom:sse-streaming');
    expect(state.topics).toHaveLength(6);

    // Progress mastery up to solid
    upsertTopicMastery(state, {
      title: 'SSE Streaming',
      mastery: 'solid',
      notes: 'Explained frame flushing accurately.',
      relatedFiles: ['src/client/api/client.ts'],
    });
    expect(state.topics).toHaveLength(6); // Deduplicated
    const updated = state.topics.find((t) => t.id === 'custom:sse-streaming');
    expect(updated?.mastery).toBe('solid');
    expect(updated?.relatedFiles).toEqual(['src/server/routes/chat.ts', 'src/client/api/client.ts']);

    // Can also step mastery down for reinforcement if gaps appear
    upsertTopicMastery(state, {
      id: 'custom:sse-streaming',
      title: 'SSE Streaming',
      mastery: 'developing',
      notes: 'Needs clearer mental model on EOF buffering.',
    });
    expect(state.topics.find((t) => t.id === 'custom:sse-streaming')?.mastery).toBe('developing');
  });

  it('strictly caps check-in questions at 3 and suggested next steps at 3', () => {
    const state = createInitialLearningState(MOCK_RECON);

    const savedQuestions = setCheckInQuestions(state, [
      { question: 'Q1?', focus: 'f1' },
      { question: 'Q2?', focus: 'f2' },
      { question: 'Q3?', focus: 'f3' },
      { question: 'Q4 should be dropped?', focus: 'f4' },
    ]);
    expect(savedQuestions).toHaveLength(3);
    expect(state.pendingCheckIn).toHaveLength(3);

    const savedSteps = setSuggestedNextSteps(state, [
      { title: 'Step 1', rationale: 'R1', prompt: 'P1', kind: 'deepen' },
      { title: 'Step 2', rationale: 'R2', prompt: 'P2', kind: 'broaden' },
      { title: 'Step 3', rationale: 'R3', prompt: 'P3', kind: 'explore' },
      { title: 'Step 4 dropped', rationale: 'R4', prompt: 'P4', kind: 'revisit' },
    ]);
    expect(savedSteps).toHaveLength(3);
    expect(state.suggestedNextSteps).toHaveLength(3);
  });

  it('detects custom topic requests versus pillar requests cleanly', () => {
    expect(detectCustomTopicRequest('Teach me about pathGuard')).toBe('pathGuard');
    expect(detectCustomTopicRequest('How does SSE streaming work?')).toBe('SSE streaming');
    expect(detectCustomTopicRequest('I want to learn gitGuard')).toBe('gitGuard');
    expect(detectCustomTopicRequest('Explain simpler')).toBeNull();

    expect(detectPillarRequest("Let's explore System Architecture")).toBe('architecture');
    expect(detectPillarRequest('Show me Git Evolution & Conventions')).toBe('evolution');
    expect(detectCustomTopicRequest("Let's explore System Architecture")).toBeNull();
  });

  it('infers uncertainty vs confident understanding on check-in replies', () => {
    const uncertain = assessCheckInResponse(
      'Honestly I am confused and not sure how those boundaries connect.',
      'introduced',
      'advanced'
    );
    expect(uncertain.looksLikeCheckInReply).toBe(true);
    expect(uncertain.needsReinforcement).toBe(true);
    expect(uncertain.newMastery).toBe('developing');
    expect(uncertain.recommendedLevelShift).toBe('down');

    const confident = assessCheckInResponse(
      'It separates the read-only pathGuard boundary so every tool validates canonical realpath before reading files.',
      'introduced',
      'intermediate'
    );
    expect(confident.looksLikeCheckInReply).toBe(true);
    expect(confident.needsReinforcement).toBe(false);
    expect(confident.newMastery).toBe('solid');
  });
});
