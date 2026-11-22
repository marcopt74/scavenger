import crypto from 'node:crypto';
import { ONBOARDING_STAGES } from '../../shared/types.js';
import type {
  CheckInQuestion,
  CorePillarId,
  LearningState,
  LearningTopic,
  RootReconSummary,
  SuggestedNextStep,
  TopicMastery,
  UserLevel,
} from '../../shared/types.js';

export const MAX_CHECKIN_QUESTIONS = 3;
export const MAX_SUGGESTED_STEPS = 3;

export function makePillarTopicId(pillarId: CorePillarId): string {
  return `pillar:${pillarId}`;
}

export function slugifyTopicTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'topic';
}

export function makeCustomTopicId(title: string): string {
  return `custom:${slugifyTopicTitle(title)}`;
}

export function createInitialLearningState(recon: RootReconSummary): LearningState {
  const now = new Date().toISOString();
  const topics: LearningTopic[] = ONBOARDING_STAGES.map((stage) => ({
    id: makePillarTopicId(stage.pillarId),
    title: stage.title,
    kind: 'pillar',
    pillarId: stage.pillarId,
    mastery: stage.pillarId === 'recon' ? 'introduced' : 'unexplored',
    notes: stage.pillarId === 'recon' ? 'Initial root reconnaissance completed.' : undefined,
    relatedFiles:
      stage.pillarId === 'recon'
        ? [recon.readmePath, ...recon.manifests.map((m) => m.path)].filter(Boolean) as string[]
        : undefined,
    lastStudiedAt: stage.pillarId === 'recon' ? now : undefined,
  }));

  const firstDir = recon.topLevelEntries.find((e) => e.type === 'dir')?.name;

  const suggestedNextSteps: SuggestedNextStep[] = [
    {
      id: `step_${crypto.randomUUID().slice(0, 6)}`,
      title: 'Repo Purpose & Domain',
      rationale: `Start with what ${recon.repoName} does and its domain boundaries.`,
      prompt: `Let's explore Repo Purpose & Domain for ${recon.repoName}.`,
      kind: 'broaden',
      targetTopicId: makePillarTopicId('purpose'),
    },
    {
      id: `step_${crypto.randomUUID().slice(0, 6)}`,
      title: 'System Architecture',
      rationale: 'Jump straight into a visual map of the major modules and boundaries.',
      prompt: `Let's explore System Architecture for ${recon.repoName} with a diagram.`,
      kind: 'explore',
      targetTopicId: makePillarTopicId('architecture'),
    },
    {
      id: `step_${crypto.randomUUID().slice(0, 6)}`,
      title: firstDir ? `Explore \`${firstDir}/\`` : 'Trace a Core Flow',
      rationale: firstDir
        ? `Go directly into the ${firstDir}/ directory and inspect how it works.`
        : 'Trace an entry-point execution flow right away.',
      prompt: firstDir
        ? `Teach me about how ${firstDir} is structured and what it does.`
        : `Let's trace a core execution flow in ${recon.repoName}.`,
      kind: 'deepen',
      targetTopicId: firstDir ? makeCustomTopicId(firstDir) : makePillarTopicId('flows'),
    },
  ];

  return {
    activeTopicId: makePillarTopicId('recon'),
    activeTopicTitle: ONBOARDING_STAGES[0].title,
    topics,
    pendingCheckIn: [],
    suggestedNextSteps,
  };
}

export interface UpsertTopicInput {
  id?: string;
  title: string;
  kind?: 'pillar' | 'custom';
  pillarId?: CorePillarId;
  mastery: TopicMastery;
  notes?: string;
  relatedFiles?: string[];
  setActive?: boolean;
}

/**
 * Updates an existing pillar/custom topic or creates a new custom topic dynamically.
 * Supports bidirectional mastery changes (progressing up or reinforcing down).
 */
export function upsertTopicMastery(state: LearningState, input: UpsertTopicInput): LearningTopic {
  const now = new Date().toISOString();
  const normalizedTitle = input.title.trim();

  // Resolve existing topic by explicit id, pillarId, or case-insensitive title match
  let existing =
    (input.id ? state.topics.find((t) => t.id === input.id) : undefined) ??
    (input.pillarId ? state.topics.find((t) => t.pillarId === input.pillarId) : undefined) ??
    state.topics.find((t) => t.title.toLowerCase() === normalizedTitle.toLowerCase());

  if (!existing) {
    const inferredKind = input.pillarId ? 'pillar' : (input.kind ?? 'custom');
    const id =
      input.id?.trim() ||
      (input.pillarId ? makePillarTopicId(input.pillarId) : makeCustomTopicId(normalizedTitle));

    existing = {
      id,
      title: normalizedTitle,
      kind: inferredKind,
      pillarId: input.pillarId,
      mastery: input.mastery,
      notes: input.notes?.trim() || undefined,
      relatedFiles: dedupePaths(input.relatedFiles),
      lastStudiedAt: now,
    };
    state.topics.push(existing);
  } else {
    existing.mastery = input.mastery;
    if (input.notes?.trim()) {
      existing.notes = input.notes.trim();
    }
    if (input.relatedFiles && input.relatedFiles.length > 0) {
      existing.relatedFiles = dedupePaths([...(existing.relatedFiles ?? []), ...input.relatedFiles]);
    }
    existing.lastStudiedAt = now;
  }

  if (input.setActive !== false) {
    state.activeTopicId = existing.id;
    state.activeTopicTitle = existing.title;
  }

  return existing;
}

export function setCheckInQuestions(
  state: LearningState,
  rawQuestions: Array<{ question: string; focus?: string; id?: string }>
): CheckInQuestion[] {
  const sanitized = rawQuestions
    .map((q) => ({
      id: q.id?.trim() || `q_${crypto.randomUUID().slice(0, 6)}`,
      question: q.question.trim(),
      focus: (q.focus || 'understanding').trim(),
    }))
    .filter((q) => q.question.length > 0)
    .slice(0, MAX_CHECKIN_QUESTIONS);

  state.pendingCheckIn = sanitized;
  return sanitized;
}

export function setSuggestedNextSteps(
  state: LearningState,
  rawSteps: Array<{
    title: string;
    rationale: string;
    prompt: string;
    kind?: SuggestedNextStep['kind'];
    targetTopicId?: string;
    id?: string;
  }>
): SuggestedNextStep[] {
  const sanitized: SuggestedNextStep[] = rawSteps
    .map((s) => ({
      id: s.id?.trim() || `step_${crypto.randomUUID().slice(0, 6)}`,
      title: s.title.trim(),
      rationale: s.rationale.trim(),
      prompt: s.prompt.trim(),
      kind: s.kind ?? 'explore',
      targetTopicId: s.targetTopicId?.trim() || undefined,
    }))
    .filter((s) => s.title.length > 0 && s.prompt.length > 0)
    .slice(0, MAX_SUGGESTED_STEPS);

  state.suggestedNextSteps = sanitized;
  return sanitized;
}

/**
 * Detects if the user explicitly asked to learn about a specific pillar.
 */
export function detectPillarRequest(text: string): CorePillarId | null {
  const lower = text.toLowerCase();
  if (/\b(root recon|revisit recon|stage\s*0)\b/.test(lower)) return 'recon';
  if (/\b(repo purpose|purpose\s*(&|and)\s*domain|what does (this|the) repo do|stage\s*1)\b/.test(lower)) {
    return 'purpose';
  }
  if (/\b(system architecture|overall architecture|module architecture|stage\s*2)\b/.test(lower)) {
    return 'architecture';
  }
  if (/\b(core flows?|execution flow|implementation flow|stage\s*3)\b/.test(lower)) {
    return 'flows';
  }
  if (/\b(git evolution|git history|commit history|conventions\s*(&|and)\s*next|stage\s*4)\b/.test(lower)) {
    return 'evolution';
  }
  return null;
}

/**
 * Detects when a user explicitly asks to learn about a custom topic, module, file, or concept
 * outside the 5 standard pillars.
 */
export function detectCustomTopicRequest(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 4) return null;

  // If it's clearly a direct request for one of the 5 named pillars, let pillar routing handle it
  if (detectPillarRequest(trimmed)) return null;

  const patterns = [
    /(?:teach me(?: about)?|i want to learn(?: about| how)?|help me understand|walk me through|explain(?: how| what)?|tell me about|dive into|focus on|let'?s learn(?: about)?|can we cover|show me how)\s+(.+)/i,
    /how does\s+(.+?)\s+work\??$/i,
  ];

  for (const regex of patterns) {
    const match = trimmed.match(regex);
    if (match?.[1]) {
      const cleaned = match[1]
        .replace(/[.?!]+$/, '')
        .replace(/\b(works?|in this repo|in the codebase|please|works here)\b/gi, '')
        .trim();
      if (cleaned.length >= 2 && cleaned.length <= 80) {
        // Avoid misclassifying pure depth recalibration as a custom topic
        if (/^(that|it|this|more simply|simpler|deeper)$/i.test(cleaned)) {
          return null;
        }
        return cleaned;
      }
    }
  }

  return null;
}

export interface CheckInAssessment {
  looksLikeCheckInReply: boolean;
  newMastery: TopicMastery;
  needsReinforcement: boolean;
  recommendedLevelShift: 'down' | 'keep' | 'up';
  summary: string;
}

/**
 * Evaluates a user's reply when check-in questions are pending to infer knowledge evolution.
 */
export function assessCheckInResponse(
  text: string,
  currentMastery: TopicMastery,
  currentLevel: UserLevel
): CheckInAssessment {
  const lower = text.toLowerCase();

  const uncertaintySignals = [
    /\b(not sure|don'?t know|unsure|confused|lost|didn'?t get|unclear|no idea|struggling|hard to follow|can you re-?explain)\b/,
    /\b(i think maybe|guessing|not really)\b/,
  ];

  const confidentSignals = [
    /\b(because|so that|which means|separates|boundary|enforces|isolates|delegates|flows from|responsible for|handles|validates|renders|streams)\b/,
    /\b(makes sense|got it|clear|understood)\b/,
  ];

  const isUncertain = uncertaintySignals.some((r) => r.test(lower));
  const isConfident = confidentSignals.some((r) => r.test(lower)) || text.trim().split(/\s+/).length >= 14;

  if (isUncertain) {
    return {
      looksLikeCheckInReply: true,
      newMastery: 'developing',
      needsReinforcement: true,
      recommendedLevelShift: currentLevel === 'advanced' ? 'down' : 'keep',
      summary: 'Detected uncertainty on check-in — reinforcing with a clearer mental model before moving deeper.',
    };
  }

  if (isConfident) {
    const nextMastery: TopicMastery =
      currentMastery === 'unexplored' || currentMastery === 'introduced' ? 'developing' : 'solid';
    return {
      looksLikeCheckInReply: true,
      newMastery: text.trim().split(/\s+/).length >= 10 ? 'solid' : nextMastery,
      needsReinforcement: false,
      recommendedLevelShift: currentLevel === 'foundational' && text.trim().split(/\s+/).length >= 16 ? 'up' : 'keep',
      summary: 'Strong comprehension on check-in — ready to deepen or branch into adjacent components.',
    };
  }

  return {
    looksLikeCheckInReply: false,
    newMastery: currentMastery === 'unexplored' ? 'introduced' : currentMastery,
    needsReinforcement: false,
    recommendedLevelShift: 'keep',
    summary: 'Continuing exploration based on user direction.',
  };
}

export function cloneLearningState(state: LearningState): LearningState {
  return {
    activeTopicId: state.activeTopicId,
    activeTopicTitle: state.activeTopicTitle,
    topics: state.topics.map((t) => ({
      ...t,
      relatedFiles: t.relatedFiles ? [...t.relatedFiles] : undefined,
    })),
    pendingCheckIn: state.pendingCheckIn.map((q) => ({ ...q })),
    suggestedNextSteps: state.suggestedNextSteps.map((s) => ({ ...s })),
    lastAssessmentSummary: state.lastAssessmentSummary,
  };
}

function dedupePaths(paths?: string[]): string[] | undefined {
  if (!paths || paths.length === 0) return undefined;
  return [...new Set(paths.map((p) => p.trim()).filter(Boolean))].slice(0, 12);
}
