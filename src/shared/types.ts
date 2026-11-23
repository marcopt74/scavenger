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

export type ProviderId =
  | 'copilot'
  | 'google'
  | 'openai'
  | 'anthropic'
  | 'openai-compatible'
  | 'demo';

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

export type RepoModuleLayer =
  | 'entry'
  | 'core'
  | 'api'
  | 'ui'
  | 'data'
  | 'guard'
  | 'shared'
  | 'test'
  | 'config';

export type RepoSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'const'
  | 'component'
  | 'route'
  | 'default';

export interface RepoExportedSymbol {
  name: string;
  kind: RepoSymbolKind;
  line: number;
}

export interface RepoImportRef {
  source: string;
  resolvedPath?: string;
  symbols: string[];
}

export interface RepoFileIndexEntry {
  path: string;
  moduleId: string;
  language: string;
  lines: number;
  sizeBytes: number;
  mtimeMs: number;
  roleSummary?: string;
  isEntryPoint?: boolean;
  exports: RepoExportedSymbol[];
  imports: RepoImportRef[];
}

export interface RepoDependencyEdge {
  from: string;
  to: string;
  kind: 'import' | 'reexport' | 'dynamic';
}

export interface RepoModuleNode {
  id: string;
  name: string;
  path: string;
  role: string;
  layer: RepoModuleLayer;
  files: string[];
  dependsOnModules: string[];
  dependedOnByModules: string[];
  keySymbols: string[];
}

export interface RepoEntryPoint {
  path: string;
  role: string;
  kind: 'server' | 'client' | 'cli' | 'library' | 'test' | 'config';
}

export interface RepoCoreFlow {
  id: string;
  name: string;
  summary: string;
  files: string[];
  steps: string[];
}

export interface RepoKnowledgeStats {
  totalFiles: number;
  indexedFiles: number;
  totalModules: number;
  totalSymbols: number;
  totalEdges: number;
  durationMs: number;
}

export interface RepoKnowledgeSummary {
  purpose: string;
  architectureOverview: string;
  entryPoints: RepoEntryPoint[];
  coreFlows: RepoCoreFlow[];
  conventions: string[];
}

export interface RepoKnowledgeMap {
  version: number;
  repoPath: string;
  repoName: string;
  headCommit?: string;
  branch?: string;
  scannedAt: string;
  updatedAt: string;
  scanStrategy: 'hybrid' | 'static';
  stats: RepoKnowledgeStats;
  summary: RepoKnowledgeSummary;
  modules: RepoModuleNode[];
  files: RepoFileIndexEntry[];
  dependencyEdges: RepoDependencyEdge[];
}

export type KnowledgeRefreshTrigger = 'initial' | 'cached' | 'git-pull-auto' | 'manual';

export interface KnowledgeBaseStatus {
  state: 'ready' | 'scanning' | 'refreshing' | 'stale' | 'error';
  headCommit?: string;
  currentRepoHead?: string;
  branch?: string;
  isStale: boolean;
  changedFilesCount?: number;
  commitsBehind?: number;
  scannedAt?: string;
  updatedAt?: string;
  scanStrategy?: 'hybrid' | 'static';
  lastRefreshTrigger?: KnowledgeRefreshTrigger;
  stats?: RepoKnowledgeStats;
  modules?: Array<{
    id: string;
    name: string;
    path: string;
    role: string;
    layer: RepoModuleLayer;
    fileCount: number;
    keySymbols: string[];
  }>;
  entryPoints?: RepoEntryPoint[];
  coreFlows?: RepoCoreFlow[];
  errorMessage?: string;
}

export type ScanPhase =
  | 'recon'
  | 'indexing'
  | 'dependencies'
  | 'synthesis'
  | 'incremental-diff'
  | 'saving';

export type ScanSSEEvent =
  | {
      type: 'scan-progress';
      phase: ScanPhase;
      message: string;
      percent: number;
      filesProcessed?: number;
      totalFiles?: number;
    }
  | {
      type: 'scan-complete';
      session: SessionPublicState;
    }
  | {
      type: 'scan-error';
      error: string;
    };

export type ConceptVisualLayout = 'pipeline' | 'hub' | 'layers';

export type ConceptVisualAccent = 'cobalt' | 'emerald' | 'violet' | 'amber';

export interface ConceptVisualElement {
  label: string;
  role: string;
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
      layout?: ConceptVisualLayout;
      accent?: ConceptVisualAccent;
      elements?: ConceptVisualElement[];
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
  knowledgeStatus?: KnowledgeBaseStatus;
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
      knowledgeStatus?: KnowledgeBaseStatus;
      observedFilesCount: number;
      observedCommitsCount: number;
    }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; error: string };

export interface HealthInfo {
  ok: boolean;
  defaultProvider: ProviderId;
  defaultModel: string;
  defaultBaseUrl?: string;
  configuredProviders: Record<ProviderId, boolean>;
  d2Available: boolean;
  imageGenAvailable: boolean;
  suggestedRepoPath: string;
}

export type SecretSource = 'settings' | 'env' | 'local' | 'none';

export interface ProviderModelPreset {
  id: string;
  label: string;
  note: string;
}

export const PROVIDER_MODEL_PRESETS: Record<ProviderId, readonly ProviderModelPreset[]> = {
  copilot: [
    { id: 'gpt-4.1', label: 'GPT-4.1', note: 'GitHub Copilot default' },
    { id: 'gpt-4o', label: 'GPT-4o', note: 'Fast & versatile' },
    { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', note: 'Architectural clarity' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', note: 'Deep reasoning' },
    { id: 'o3-mini', label: 'o3-mini', note: 'Reasoning model' },
  ],
  google: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'Fast & balanced' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', note: 'Deep reasoning' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', note: 'Lightweight' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o', note: 'Versatile flagship' },
    { id: 'gpt-4.1', label: 'GPT-4.1', note: 'Strong code analysis' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', note: 'Fast & economical' },
    { id: 'o3-mini', label: 'o3-mini', note: 'Reasoning model' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', note: 'Architectural clarity' },
    { id: 'claude-3-7-sonnet-latest', label: 'Claude 3.7 Sonnet', note: 'Deep code mentor' },
    { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku', note: 'Fast responses' },
  ],
  'openai-compatible': [
    { id: 'llama3.2', label: 'Llama 3.2', note: 'Local Ollama default' },
    { id: 'qwen2.5-coder:14b', label: 'Qwen 2.5 Coder 14B', note: 'Code specialist' },
    { id: 'deepseek-r1:14b', label: 'DeepSeek R1 14B', note: 'Local reasoning' },
  ],
  demo: [
    { id: 'local-grounded-demo', label: 'Local Grounded Demo', note: 'Zero API key' },
  ],
};

export interface ProviderPublicConfig {
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  hasKey: boolean;
  maskedKey?: string;
  keySource: SecretSource;
  sourceDetail?: string;
  ready: boolean;
}

export interface CopilotModelsResponse {
  models: ProviderModelPreset[];
  source: 'live' | 'presets';
  error?: string;
}

export interface CopilotDeviceFlowStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  domain?: string;
}

export interface CopilotDeviceFlowPollResponse {
  status: 'pending' | 'slow_down' | 'complete' | 'expired' | 'denied';
  interval?: number;
  message?: string;
  settings?: PublicSettings;
  health?: HealthInfo;
}

export interface VisualPublicSettings {
  imageGenEnabled: boolean;
  geminiImageModel: string;
  openaiImageModel: string;
  imageGenAvailable: boolean;
  d2Available: boolean;
}

export interface PublicSettings {
  activeProvider: ProviderId;
  providers: Record<ProviderId, ProviderPublicConfig>;
  visuals: VisualPublicSettings;
  storagePath: string;
}

export interface ProviderUpdateInput {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface UpdateSettingsPayload {
  activeProvider?: ProviderId;
  providers?: Partial<Record<Exclude<ProviderId, 'demo'>, ProviderUpdateInput>>;
  visuals?: {
    imageGenEnabled?: boolean;
    geminiImageModel?: string;
    openaiImageModel?: string;
  };
}

export interface TestConnectionPayload {
  provider: ProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  provider: ProviderId;
  model: string;
  latencyMs: number;
  message: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  isHidden: boolean;
  isSymlink: boolean;
}

export interface DirectoryBreadcrumb {
  name: string;
  path: string;
}

export interface DirectoryShortcut {
  label: string;
  path: string;
  kind: 'home' | 'workspace' | 'folder' | 'root';
}

export interface DirectoryBrowseResponse {
  currentPath: string;
  parentPath: string | null;
  isCurrentGitRepo: boolean;
  breadcrumbs: DirectoryBreadcrumb[];
  entries: DirectoryEntry[];
  fileCount: number;
  truncated: boolean;
  shortcuts: DirectoryShortcut[];
}
