import { ONBOARDING_STAGES, PILLAR_TO_STAGE, STAGE_TO_PILLAR } from '../../shared/types.js';
import type {
  CorePillarId,
  DiagnosticProfile,
  OnboardingStage,
  StageMetadata,
  UserLevel,
} from '../../shared/types.js';

export function getStageMetadata(stage: OnboardingStage): StageMetadata {
  return ONBOARDING_STAGES[stage];
}

export function pillarToStage(pillarId: CorePillarId): OnboardingStage {
  return PILLAR_TO_STAGE[pillarId];
}

export function stageToPillar(stage: OnboardingStage): CorePillarId {
  return STAGE_TO_PILLAR[stage];
}

export interface StageTransitionResult {
  allowed: boolean;
  nextStage: OnboardingStage;
  reason?: string;
}

/**
 * Non-linear pillar navigation: users and the adaptive mentor can move freely
 * between any core repository pillar or revisit earlier concepts as knowledge evolves.
 */
export function validateStageTransition(
  _currentStage: OnboardingStage,
  targetStage: OnboardingStage
): StageTransitionResult {
  return { allowed: true, nextStage: targetStage };
}

/**
 * Infers user technical level from free-text diagnostic replies or recalibration messages.
 */
export function inferUserLevelFromText(text: string, fallback: UserLevel = 'intermediate'): UserLevel {
  const lower = text.toLowerCase();

  const foundationalPatterns = [
    /\b(beginner|new to|never used|first time|foundational|junior|student|learning|novice|low)\b/,
    /\b(simpler|simplify|eli5|plain english|high[- ]level only|less jargon|basic|gentle|conceptual)\b/,
  ];
  if (foundationalPatterns.some((re) => re.test(lower))) {
    return 'foundational';
  }

  const advancedPatterns = [
    /\b(advanced|senior|staff|principal|architect|deep dive|expert|years of experience|very familiar|high)\b/,
    /\b(go deeper|more technical|under the hood|internals|trade[- ]?offs|invariants|low[- ]level)\b/,
  ];
  if (advancedPatterns.some((re) => re.test(lower))) {
    return 'advanced';
  }

  const intermediatePatterns = [
    /\b(intermediate|mid[- ]level|some experience|familiar with|comfortable with|moderate|balanced)\b/,
  ];
  if (intermediatePatterns.some((re) => re.test(lower))) {
    return 'intermediate';
  }

  return fallback === 'uncalibrated' ? 'intermediate' : fallback;
}

/**
 * Detects whether a user message explicitly requests recalibrating depth up or down.
 */
export function detectRecalibrationSignal(text: string, currentLevel: UserLevel): UserLevel | null {
  const lower = text.toLowerCase();

  if (/\b(simpler|simplify|too dense|too technical|slow down|less jargon|explain like|foundational|more basic)\b/.test(lower)) {
    if (currentLevel === 'advanced') return 'intermediate';
    return 'foundational';
  }

  if (/\b(go deeper|deeper|more detail|more technical|skip basics|advanced|show internals|under the hood)\b/.test(lower)) {
    if (currentLevel === 'foundational') return 'intermediate';
    return 'advanced';
  }

  return null;
}

/**
 * Updates diagnostic profile cleanly while keeping existing fields intact.
 */
export function mergeDiagnosticProfile(
  existing: DiagnosticProfile,
  patch: Partial<DiagnosticProfile>
): DiagnosticProfile {
  return {
    stackFamiliarity: patch.stackFamiliarity ?? existing.stackFamiliarity,
    goal: patch.goal ?? existing.goal,
    preferredDepth: patch.preferredDepth ?? existing.preferredDepth,
    inferredLevel: patch.inferredLevel ?? existing.inferredLevel,
    completed: patch.completed ?? existing.completed,
  };
}
