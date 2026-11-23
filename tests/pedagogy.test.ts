import { describe, expect, it } from 'vitest';
import type { RootReconSummary } from '../src/shared/types.js';
import { buildPedagogySection, getProgressionBalance } from '../src/server/agent/pedagogy.js';
import { buildSystemPrompt } from '../src/server/agent/systemPrompt.js';
import { createSession } from '../src/server/session/sessionStore.js';

const MOCK_RECON: RootReconSummary = {
  repoName: 'sample-repo',
  repoPath: '/tmp/sample-repo',
  isGitRepo: true,
  topLevelTree: 'sample-repo/\n├── src/\n└── package.json',
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

describe('pedagogy (Whiteboard Mentor lesson craft & dynamic progression)', () => {
  it('encodes the 5-beat teaching arc, anti-dryness rules, and predictive check-in craft', () => {
    const section = buildPedagogySection({
      level: 'intermediate',
      activeMastery: 'developing',
      activeTopicTitle: 'System Architecture',
    });

    expect(section).toContain('The 5-Beat Lesson Arc');
    expect(section).toContain('Interdependencies');
    expect(section).toContain('Interactions Over Time');
    expect(section).toContain('Subtle behavior to notice');
    expect(section).toContain('Mental model to keep');
    expect(section).toContain('Yellow Highlighter for Key Ideas');
    expect(section).toContain('==');
    expect(section).toContain('Never emit dry file-inventory bullet soup');
    expect(section).toContain('300–500 words');
    expect(section).toContain('predictive, causal, or boundary-reasoning questions');
  });

  it('adapts lesson balance dynamically across foundational, intermediate, and advanced mastery states', () => {
    const firstEncounter = getProgressionBalance('foundational', 'introduced');
    expect(firstEncounter).toContain('First Encounter');
    expect(firstEncounter).toContain('concrete analogy');

    const building = getProgressionBalance('intermediate', 'developing');
    expect(building).toContain('Building Fluency');
    expect(building).toContain('interdependencies');

    const deep = getProgressionBalance('advanced', 'solid');
    expect(deep).toContain('Deepening Mastery');
    expect(deep).toContain('failure modes');
    expect(deep).toContain('architectural trade-offs');
  });

  it('embeds Whiteboard Mentor pedagogy and warm welcome framing into session prompts', () => {
    const session = createSession(MOCK_RECON);
    const prompt = buildSystemPrompt(session, { d2Available: false });

    expect(prompt).toContain('The Whiteboard Mentor Method');
    expect(prompt).toContain('2–3 interacting files');
    expect(prompt).toContain('yellow highlighter');
    expect(session.messages[0].content).toContain('Welcome aboard!');
    expect(session.messages[0].content).toContain('whiteboard');
    expect(session.messages[0].content).toContain('==');
  });
});
