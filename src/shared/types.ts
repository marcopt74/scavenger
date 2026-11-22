export type OnboardingStage = 0 | 1 | 2 | 3 | 4;

export interface StageMetadata {
  id: OnboardingStage;
  shortLabel: string;
  title: string;
  description: string;
}

export const ONBOARDING_STAGES: readonly StageMetadata[] = [
  {
    id: 0,
    shortLabel: 'Recon',
    title: 'Diagnostic & Root Recon',
    description: 'Inspect repository root and calibrate depth to your background and goal.',
  },
  {
    id: 1,
    shortLabel: 'Purpose',
    title: 'Repo Purpose & Domain',
    description: 'Clarify what the repository does, who it serves, and its domain boundaries.',
  },
  {
    id: 2,
    shortLabel: 'Architecture',
    title: 'System Architecture',
    description: 'Map major modules, boundaries, dependencies, and architectural patterns.',
  },
  {
    id: 3,
    shortLabel: 'Flows',
    title: 'Core Flows & Implementation',
    description: 'Trace real execution paths, entry points, and key symbols at your depth.',
  },
  {
    id: 4,
    shortLabel: 'Evolution',
    title: 'Git Evolution & Next Steps',
    description: 'Surface git history decisions, local conventions, and concrete files to explore next.',
  },
] as const;

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
  visuals?: VisualArtifact[];
  toolActivities?: ToolActivity[];
}

export interface SessionPublicState {
  id: string;
  repoPath: string;
  repoName: string;
  currentStage: OnboardingStage;
  completedStages: OnboardingStage[];
  diagnostic: DiagnosticProfile;
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
