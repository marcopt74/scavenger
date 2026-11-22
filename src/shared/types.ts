export type OnboardingStage = 0 | 1 | 2 | 3 | 4;

export type CorePillarId = 'recon' | 'purpose' | 'architecture' | 'flows' | 'evolution';

export type TopicMastery = 'unexplored' | 'introduced' | 'developing' | 'solid';

export interface StageMetadata {
  id: OnboardingStage;
  pillarId: CorePillarId;
  shortLabel: string;
  title: string;
  description: string;
}

export const ONBOARDING_STAGES: readonly StageMetadata[] = [
  {
    id: 0,
    pillarId: 'recon',
    shortLabel: 'Recon',
    title: 'Root Recon & Calibration',
    description: 'Inspect repository root and calibrate depth to your background and goal.',
  },
  {
    id: 1,
    pillarId: 'purpose',
    shortLabel: 'Purpose',
    title: 'Repo Purpose & Domain',
    description: 'Clarify what the repository does, who it serves, and its domain boundaries.',
  },
  {
    id: 2,
    pillarId: 'architecture',
    shortLabel: 'Architecture',
    title: 'System Architecture',
    description: 'Map major modules, boundaries, dependencies, and architectural patterns.',
  },
  {
    id: 3,
    pillarId: 'flows',
    shortLabel: 'Flows',
    title: 'Core Flows & Implementation',
    description: 'Trace real execution paths, entry points, and key symbols at your depth.',
  },
  {
    id: 4,
    pillarId: 'evolution',
    shortLabel: 'Evolution',
    title: 'Git Evolution & Conventions',
    description: 'Surface git history decisions, local conventions, and concrete files to explore next.',
  },
] as const;

export const PILLAR_TO_STAGE: Record<CorePillarId, OnboardingStage> = {
  recon: 0,
  purpose: 1,
  architecture: 2,
  flows: 3,
  evolution: 4,
};

export const STAGE_TO_PILLAR: Record<OnboardingStage, CorePillarId> = {
  0: 'recon',
  1: 'purpose',
  2: 'architecture',
  3: 'flows',
  4: 'evolution',
};

export type UserLevel = 'uncalibrated' | 'foundational' | 'intermediate' | 'advanced';

export type ProviderId = 'google' | 'openai' | 'anthropic' | 'openai-compatible' | 'demo';

export interface ProviderSelection {
  provider: ProviderId;
  model?: string;
  baseUrl?: string;
}

export interface DiagnosticProfile {
  stackFamiliarity?: string;
  goal?: string;
  preferredDepth?: string;
  inferredLevel: UserLevel;
  completed: boolean;
}

export interface LearningTopic {
  id: string;
  title: string;
  kind: 'pillar' | 'custom';
  pillarId?: CorePillarId;
  mastery: TopicMastery;
  notes?: string;
  relatedFiles?: string[];
  lastStudiedAt?: string;
}

export interface CheckInQuestion {
  id: string;
  question: string;
  focus: string;
}

export interface SuggestedNextStep {
  id: string;
  title: string;
  rationale: string;
  prompt: string;
  kind: 'deepen' | 'broaden' | 'revisit' | 'explore';
  targetTopicId?: string;
}

export interface LearningState {
  activeTopicId: string;
  activeTopicTitle: string;
  topics: LearningTopic[];
  pendingCheckIn: CheckInQuestion[];
  suggestedNextSteps: SuggestedNextStep[];
  lastAssessmentSummary?: string;
}

export interface ManifestSnapshot {
  path: string;
  kind: string;
  excerpt: string;
}

export interface GitMilestone {
  hash: string;
  shortHash: string;
  date: string;
  author: string;
  subject: string;
}

export interface RootReconSummary {
  repoName: string;
  repoPath: string;
  isGitRepo: boolean;
  branch?: string;
  topLevelTree: string;
  topLevelEntries: Array<{ name: string; type: 'dir' | 'file' }>;
  readmePath?: string;
  readmeExcerpt?: string;
  manifests: ManifestSnapshot[];
  recentMilestones: GitMilestone[];
  recentTags: string[];
  topContributors: string[];
  detectedStack: string[];
  inspectedAt: string;
}

export type VisualArtifact =
  | {
      id: string;
      kind: 'mermaid';
      title: string;
      caption?: string;
      source: string;
    }
  | {
      id: string;
      kind: 'd2';
      title: string;
      caption?: string;
      source: string;
      svgMarkup?: string;
      renderError?: string;
    }
  | {
      id: string;
      kind: 'concept-image';
      title: string;
      caption?: string;
      metaphor?: string;
      imageDataUrl?: string;
      svgMarkup?: string;
      isFallback: boolean;
      fallbackReason?: string;
    };

export interface ToolActivity {
  id: string;
  toolName: string;
  summary: string;
  target?: string;
  status: 'running' | 'completed' | 'blocked' | 'error';
  detail?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  stage: OnboardingStage;
  topicTitle?: string;
  visuals?: VisualArtifact[];
  toolActivities?: ToolActivity[];
  checkInQuestions?: CheckInQuestion[];
  suggestedNextSteps?: SuggestedNextStep[];
}

export interface SessionPublicState {
  id: string;
  repoPath: string;
  repoName: string;
  currentStage: OnboardingStage;
  completedStages: OnboardingStage[];
  diagnostic: DiagnosticProfile;
  learning: LearningState;
  rootRecon: RootReconSummary;
  provider: ProviderSelection;
  observedFilesCount: number;
  observedCommitsCount: number;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export type SSEEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-activity'; activity: ToolActivity }
  | { type: 'visual'; visual: VisualArtifact }
  | {
      type: 'session-state';
      currentStage: OnboardingStage;
      completedStages: OnboardingStage[];
      diagnostic: DiagnosticProfile;
      learning: LearningState;
      observedFilesCount: number;
      observedCommitsCount: number;
    }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; error: string };

export interface HealthInfo {
  ok: boolean;
  defaultProvider: ProviderId;
  defaultModel: string;
  configuredProviders: Record<ProviderId, boolean>;
  d2Available: boolean;
  imageGenAvailable: boolean;
  suggestedRepoPath: string;
}
