import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SSEEvent } from '../src/shared/types.js';
import { runOnboardingTurn } from '../src/server/agent/orchestrator.js';
import { createSession } from '../src/server/session/sessionStore.js';
import {
  detectRecalibrationSignal,
  inferUserLevelFromText,
  validateStageTransition,
} from '../src/server/session/stageMachine.js';
import { runRootRecon } from '../src/server/tools/rootRecon.js';

describe('adaptive non-linear onboarding & mastery progression', () => {
  let tempRepo: string;

  beforeAll(async () => {
    tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-stage-'));
    await fs.mkdir(path.join(tempRepo, 'src', 'auth'), { recursive: true });
    await fs.writeFile(path.join(tempRepo, 'README.md'), '# Demo Service\nHandles webhooks & auth tokens.\n');
    await fs.writeFile(path.join(tempRepo, 'package.json'), '{"name":"demo-service"}');
    await fs.writeFile(
      path.join(tempRepo, 'src', 'index.ts'),
      'export function startServer() { return true; }\n'
    );
    await fs.writeFile(
      path.join(tempRepo, 'src', 'auth', 'tokenGuard.ts'),
      'export function verifyToken(token: string) { return token.startsWith("tok_"); }\n'
    );
  });

  afterAll(async () => {
    await fs.rm(tempRepo, { recursive: true, force: true });
  });

  it('infers foundational, intermediate, and advanced levels from diagnostic text', () => {
    expect(inferUserLevelFromText('I am a beginner and new to TypeScript, keep it simple.')).toBe('foundational');
    expect(inferUserLevelFromText('Mid-level developer, comfortable with Node, balanced detail.')).toBe('intermediate');
    expect(inferUserLevelFromText('Staff engineer, go deep into internals and trade-offs.')).toBe('advanced');
  });

  it('detects smooth depth recalibration requests', () => {
    expect(detectRecalibrationSignal('Can you explain simpler with less jargon?', 'advanced')).toBe('intermediate');
    expect(detectRecalibrationSignal('Explain simpler please', 'intermediate')).toBe('foundational');
    expect(detectRecalibrationSignal('Go deeper on internals', 'foundational')).toBe('intermediate');
    expect(detectRecalibrationSignal('Go deeper on internals', 'intermediate')).toBe('advanced');
  });

  it('allows free non-linear movement between pillars', () => {
    expect(validateStageTransition(0, 3)).toEqual({ allowed: true, nextStage: 3 });
    expect(validateStageTransition(4, 1)).toEqual({ allowed: true, nextStage: 1 });
  });

  it('steers non-linearly: custom topic learning, check-in mastery inference, reinforcement, and 2-3 next steps', async () => {
    const recon = await runRootRecon(tempRepo);
    const session = createSession(recon, { provider: 'demo', model: 'local-grounded-demo' });

    expect(session.learning.activeTopicId).toBe('pillar:recon');
    expect(session.messages[0].suggestedNextSteps?.length).toBe(3);

    const runTurn = async (text: string) => {
      const events: SSEEvent[] = [];
      const msg = await runOnboardingTurn(session, text, (e) => events.push(e));
      return { msg, events };
    };

    // Turn 1: User answers calibration -> Purpose lesson + <=3 check-in Qs + 2-3 next steps
    const t1 = await runTurn('I am new to this stack and want mental models first.');
    expect(session.diagnostic.inferredLevel).toBe('foundational');
    expect(session.learning.activeTopicId).toBe('pillar:purpose');
    expect(t1.msg.checkInQuestions?.length).toBeGreaterThanOrEqual(1);
    expect(t1.msg.checkInQuestions?.length).toBeLessThanOrEqual(3);
    expect(t1.msg.suggestedNextSteps?.length).toBeGreaterThanOrEqual(2);
    expect(t1.msg.suggestedNextSteps?.length).toBeLessThanOrEqual(3);

    // Turn 2: User ignores linear order and asks to learn a custom topic ("tokenGuard")
    const t2 = await runTurn('Teach me about tokenGuard');
    expect(session.learning.activeTopicId).toBe('custom:tokenguard');
    expect(session.learning.topics.some((t) => t.id === 'custom:tokenguard' && t.kind === 'custom')).toBe(true);
    expect(t2.msg.content).toContain('src/auth/tokenGuard.ts');
    expect(t2.msg.visuals?.some((v) => v.kind === 'mermaid')).toBe(true);
    expect(t2.msg.checkInQuestions?.length).toBeLessThanOrEqual(3);
    expect(t2.msg.suggestedNextSteps?.length).toBeGreaterThanOrEqual(2);

    // Turn 3: User answers check-in with confusion -> mastery becomes developing & triggers reinforcement
    const t3 = await runTurn('I am confused and not sure how tokenGuard fits in.');
    const customTopic = session.learning.topics.find((t) => t.id === 'custom:tokenguard');
    expect(customTopic?.mastery).toBe('developing');
    expect(t3.msg.content).toContain('Reinforcing');

    // Turn 4: User replies with solid understanding -> upgrades mastery to solid and advances naturally
    const t4 = await runTurn(
      'Makes sense now because tokenGuard isolates token validation at the auth boundary before core handlers run.'
    );
    expect(session.learning.topics.find((t) => t.id === 'custom:tokenguard')?.mastery).toBe('solid');
    expect(t4.msg.content).toContain('Solid reasoning');

    // Turn 5: User explicitly jumps backward to revisit Repo Purpose & Domain
    const t5 = await runTurn("Let's revisit Repo Purpose & Domain");
    expect(session.learning.activeTopicId).toBe('pillar:purpose');
    expect(t5.msg.suggestedNextSteps?.length).toBeGreaterThanOrEqual(2);
  });
});
