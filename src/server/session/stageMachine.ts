import { ONBOARDING_STAGES } from '../../shared/types.js';
import type { DiagnosticProfile, OnboardingStage, StageMetadata, UserLevel } from '../../shared/types.js';

export function getStageMetadata(stage: OnboardingStage): StageMetadata {
  return ONBOARDING_STAGES[stage];
}

export interface StageTransitionResult {
  allowed: boolean;
  nextStage: OnboardingStage;
  reason?: string;
}

/**
 * Enforces progressive Stage 0 -> 1 -> 2 -> 3 -> 4 discovery unless the user
 * explicitly asked to jump ahead (e.g., inspecting implementation files early).
 */
export function validateStageTransition(
  currentStage: OnboardingStage,
  targetStage: OnboardingStage,
  options?: { userRequestedJump?: boolean }
): StageTransitionResult {
  if (targetStage === currentStage) {
    return { allowed: true, nextStage: currentStage };
  }

  // Moving backward to revisit an earlier stage is always allowed
  if (targetStage < currentStage) {
    return { allowed: true, nextStage: targetStage };
  }

  // Advancing one stage at a time is the normal progressive path
  if (targetStage === currentStage + 1) {
    return { allowed: true, nextStage: targetStage };
  }

  // Jumping ahead multiple stages requires explicit user request
  if (options?.userRequestedJump) {
    return { allowed: true, nextStage: targetStage };
  }

  const nextProgressive = Math.min(4, currentStage + 1) as OnboardingStage;
  return {
    allowed: false,
    nextStage: nextProgressive,
    reason: `Progressive onboarding rule: establish Stage ${nextProgressive} (${ONBOARDING_STAGES[nextProgressive].title}) before jumping to Stage ${targetStage}, unless the user explicitly asks to jump ahead.`,
  };
}

/**
 * Infers user technical level from free-text diagnostic replies or recalibration messages.
 */
export function inferUserLevelFromText(text: string, fallback: UserLevel = 'intermediate'): UserLevel {
  const lower = text.toLowerCase();

  // Explicit recalibration / strong foundational signals
  const foundationalPatterns = [
    /\b(beginner|new to|never used|first time|foundational|junior|student|learning|novice)\b/,
    /\b(simpler|simplify|eli5|plain english|high[- ]level only|less jargon|basic|gentle)\b/,
  ];
  if (foundationalPatterns.some((re) => re.test(lower))) {
    return 'foundational';
  }

  // Strong advanced signals
  const advancedPatterns = [
    /\b(advanced|senior|staff|principal|architect|deep dive|expert|years of experience|very familiar)\b/,
    /\b(go deeper|more technical|under the hood|internals|trade[- ]?offs|invariants|low[- ]level)\b/,
  ];
  if (advancedPatterns.some((re) => re.test(lower))) {
    return 'advanced';
  }

  // Explicit intermediate signals
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
 * Detects whether the user explicitly asks to jump ahead to code, flows, or git history.
 */
export function detectJumpAheadRequest(text: string): { requested: boolean; targetStage?: OnboardingStage } {
  const lower = text.toLowerCase();

  if (/\b(jump to|skip to|go straight to|show me the code|dive straight into|jump ahead)\b/.test(lower)) {
    if (/\b(git|history|commit|churn|evolution|next steps)\b/.test(lower)) {
      return { requested: true, targetStage: 4 };
    }
    if (/\b(flow|code|implementation|entry ?point|function|symbol|trace)\b/.test(lower)) {
      return { requested: true, targetStage: 3 };
    }
    if (/\b(arch|module|component|structure|diagram)\b/.test(lower)) {
      return { requested: true, targetStage: 2 };
    }
    return { requested: true, targetStage: 3 };
  }

  return { requested: false };
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
