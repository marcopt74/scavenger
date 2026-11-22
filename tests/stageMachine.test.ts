import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SSEEvent } from '../src/shared/types.js';
import { runOnboardingTurn } from '../src/server/agent/orchestrator.js';
import { createSession } from '../src/server/session/sessionStore.js';
import {
  detectJumpAheadRequest,
  detectRecalibrationSignal,
  inferUserLevelFromText,
  validateStageTransition,
} from '../src/server/session/stageMachine.js';
import { runRootRecon } from '../src/server/tools/rootRecon.js';

describe('stageMachine & diagnostic onboarding progression', () => {
  let tempRepo: string;

  beforeAll(async () => {
    tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-stage-'));
    await fs.mkdir(path.join(tempRepo, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempRepo, 'README.md'), '# Demo Service\nHandles webhooks.\n');
    await fs.writeFile(path.join(tempRepo, 'package.json'), '{"name":"demo-service"}');
    await fs.writeFile(path.join(tempRepo, 'src', 'index.ts'), 'export function start() { return true; }\n');
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

  it('enforces progressive stage advancement unless user explicitly requests jumping ahead', () => {
    expect(validateStageTransition(0, 1)).toEqual({ allowed: true, nextStage: 1 });
    expect(validateStageTransition(1, 3).allowed).toBe(false);
    expect(validateStageTransition(1, 3).nextStage).toBe(2);
    expect(validateStageTransition(1, 3, { userRequestedJump: true })).toEqual({
      allowed: true,
      nextStage: 3,
    });
    expect(detectJumpAheadRequest('Skip to implementation code please')).toEqual({
      requested: true,
      targetStage: 3,
    });
  });

  it('walks through Stages 0 -> 1 -> 2 -> 3 -> 4 in grounded demo mode with visuals and recalibration', async () => {
    const recon = await runRootRecon(tempRepo);
    const session = createSession(recon, { provider: 'demo', model: 'local-grounded-demo' });

    expect(session.currentStage).toBe(0);
    expect(session.diagnostic.inferredLevel).toBe('uncalibrated');
    expect(session.messages[0].content).toContain('Stack familiarity');

    const runTurn = async (text: string) => {
      const events: SSEEvent[] = [];
      const msg = await runOnboardingTurn(session, text, (e) => events.push(e));
      return { msg, events };
    };

    // Stage 0 -> Stage 1 via diagnostic reply
    const s1 = await runTurn('I am new to this stack and want a conceptual overview first.');
    expect(session.currentStage).toBe(1);
    expect(session.diagnostic.inferredLevel).toBe('foundational');
    expect(s1.msg.visuals?.some((v) => v.kind === 'concept-image')).toBe(true);

    // Stage 1 -> Stage 2 (Architecture + Mermaid SVG artifact)
    const s2 = await runTurn('Continue to Stage 2 architecture');
    expect(session.currentStage).toBe(2);
    expect(s2.msg.visuals?.some((v) => v.kind === 'mermaid')).toBe(true);

    // Mid-session smooth recalibration
    await runTurn('Go deeper please');
    expect(session.diagnostic.inferredLevel).toBe('intermediate');

    // Stage 2 -> Stage 3 (Core flows + entry point inspection)
    const s3 = await runTurn('Next stage: core flows');
    expect(session.currentStage).toBe(3);
    expect(s3.msg.content).toContain('src/index.ts');
    expect(s3.msg.visuals?.some((v) => v.kind === 'mermaid')).toBe(true);

    // Stage 3 -> Stage 4 (Git evolution & next steps)
    const s4 = await runTurn('Continue to Stage 4');
    expect(session.currentStage).toBe(4);
    expect(s4.msg.content).toContain('Stage 4');
  });
});
