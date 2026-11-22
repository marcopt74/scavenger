import crypto from 'node:crypto';
import type {
  ChatMessage,
  DiagnosticProfile,
  LearningState,
  OnboardingStage,
  ProviderSelection,
  RootReconSummary,
  SessionPublicState,
  ToolActivity,
  UserLevel,
} from '../../shared/types.js';
import { getDefaultProviderSelection } from '../config.js';
import { cloneLearningState, createInitialLearningState } from './learningEngine.js';

export interface InternalSession {
  id: string;
  repoPath: string;
  repoName: string;
  currentStage: OnboardingStage;
  completedStages: Set<OnboardingStage>;
  diagnostic: DiagnosticProfile;
  learning: LearningState;
  rootRecon: RootReconSummary;
  provider: ProviderSelection;
  observedFiles: Set<string>;
  observedCommits: Set<string>;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

const sessions = new Map<string, InternalSession>();

export function createSession(
  rootRecon: RootReconSummary,
  providerOverride?: ProviderSelection
): InternalSession {
  const id = `sess_${crypto.randomUUID().slice(0, 10)}`;
  const now = new Date().toISOString();
  const provider = providerOverride ?? getDefaultProviderSelection();
  const learning = createInitialLearningState(rootRecon);

  const observedFiles = new Set<string>();
  if (rootRecon.readmePath) observedFiles.add(rootRecon.readmePath);
  for (const m of rootRecon.manifests) observedFiles.add(m.path);
  for (const e of rootRecon.topLevelEntries) observedFiles.add(e.name);

  const observedCommits = new Set<string>();
  for (const c of rootRecon.recentMilestones) {
    observedCommits.add(c.shortHash);
    observedCommits.add(c.hash);
  }

  const openingActivities: ToolActivity[] = [
    {
      id: `act_${crypto.randomUUID().slice(0, 6)}`,
      toolName: 'list_tree',
      summary: `Scanned root layout (${rootRecon.topLevelEntries.length} top-level entries)`,
      target: '.',
      status: 'completed',
    },
  ];

  if (rootRecon.readmePath) {
    openingActivities.push({
      id: `act_${crypto.randomUUID().slice(0, 6)}`,
      toolName: 'read_file',
      summary: `Read root documentation (${rootRecon.readmePath})`,
      target: rootRecon.readmePath,
      status: 'completed',
    });
  }

  if (rootRecon.manifests.length > 0) {
    openingActivities.push({
      id: `act_${crypto.randomUUID().slice(0, 6)}`,
      toolName: 'read_file',
      summary: `Inspected ${rootRecon.manifests.length} root manifest${rootRecon.manifests.length === 1 ? '' : 's'} (${rootRecon.manifests.map((m) => m.path).slice(0, 3).join(', ')})`,
      target: rootRecon.manifests[0].path,
      status: 'completed',
    });
  }

  if (rootRecon.isGitRepo) {
    openingActivities.push({
      id: `act_${crypto.randomUUID().slice(0, 6)}`,
      toolName: 'git_inspect',
      summary: `Checked git history (${rootRecon.recentMilestones.length} recent commits${rootRecon.branch ? ` on ${rootRecon.branch}` : ''})`,
      target: 'git log',
      status: 'completed',
    });
  }

  const openingMessage: ChatMessage = {
    id: `msg_${crypto.randomUUID().slice(0, 8)}`,
    role: 'assistant',
    content: buildStage0OpeningMessage(rootRecon),
    createdAt: now,
    stage: 0,
    topicTitle: learning.activeTopicTitle,
    toolActivities: openingActivities,
    suggestedNextSteps: learning.suggestedNextSteps.map((s) => ({ ...s })),
  };

  const session: InternalSession = {
    id,
    repoPath: rootRecon.repoPath,
    repoName: rootRecon.repoName,
    currentStage: 0,
    completedStages: new Set<OnboardingStage>(),
    diagnostic: {
      inferredLevel: 'uncalibrated',
      completed: false,
    },
    learning,
    rootRecon,
    provider,
    observedFiles,
    observedCommits,
    messages: [openingMessage],
    createdAt: now,
    updatedAt: now,
  };

  sessions.set(id, session);
  return session;
}

export function getSession(id: string): InternalSession | undefined {
  return sessions.get(id);
}

export function updateSessionCalibration(
  session: InternalSession,
  patch: {
    inferredLevel?: UserLevel;
    currentStage?: OnboardingStage;
    provider?: ProviderSelection;
  }
): InternalSession {
  if (patch.inferredLevel) {
    session.diagnostic.inferredLevel = patch.inferredLevel;
    if (patch.inferredLevel !== 'uncalibrated') {
      session.diagnostic.completed = true;
    }
  }
  if (patch.currentStage !== undefined) {
    session.currentStage = patch.currentStage;
  }
  if (patch.provider) {
    session.provider = patch.provider;
  }
  session.updatedAt = new Date().toISOString();
  return session;
}

export function toPublicState(session: InternalSession): SessionPublicState {
  return {
    id: session.id,
    repoPath: session.repoPath,
    repoName: session.repoName,
    currentStage: session.currentStage,
    completedStages: [...session.completedStages].sort((a, b) => a - b),
    diagnostic: { ...session.diagnostic },
    learning: cloneLearningState(session.learning),
    rootRecon: session.rootRecon,
    provider: { ...session.provider },
    observedFilesCount: session.observedFiles.size,
    observedCommitsCount: session.observedCommits.size,
    messages: session.messages,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function buildStage0OpeningMessage(recon: RootReconSummary): string {
  const stackLine =
    recon.detectedStack.length > 0
      ? `**Detected stack:** ${recon.detectedStack.join(', ')}`
      : '**Detected stack:** General codebase (inspecting structure next)';

  const manifestList =
    recon.manifests.length > 0
      ? recon.manifests.map((m) => `\`${m.path}\``).slice(0, 5).join(', ')
      : 'no standard package manifest at root';

  const topDirs = recon.topLevelEntries
    .filter((e) => e.type === 'dir')
    .slice(0, 6)
    .map((e) => `\`${e.name}/\``)
    .join(', ');

  const gitLine = recon.isGitRepo
    ? recon.recentMilestones.length > 0
      ? `Git history is available (${recon.branch ? `branch \`${recon.branch}\`, ` : ''}latest commit \`${recon.recentMilestones[0].shortHash}\` on ${recon.recentMilestones[0].date}).`
      : `Initialized Git repository${recon.branch ? ` on \`${recon.branch}\`` : ''} (no commits recorded yet).`
    : 'No `.git` history detected in this folder (filesystem inspection only).';

  return [
    `I've completed an initial read-only root reconnaissance of **\`${recon.repoName}\`**.`,
    '',
    `- ${stackLine}`,
    `- **Root signals:** ${recon.readmePath ? `\`${recon.readmePath}\`, ` : ''}${manifestList}${topDirs ? ` · top directories: ${topDirs}` : ''}`,
    `- **History:** ${gitLine}`,
    '',
    `You can guide this learning session in any direction. To tailor depth right away, feel free to share a quick calibration — **or skip straight ahead by clicking a topic below or telling me anything you want to learn first**:`,
    '',
    `1. **Stack familiarity:** How comfortable are you with ${recon.detectedStack.length > 0 ? recon.detectedStack.slice(0, 3).join(' / ') : 'this tech stack'}?`,
    `2. **Your goal:** What brings you into \`${recon.repoName}\` today (orientation, architecture review, fixing a bug, adding a feature)?`,
    `3. **Preferred style:** Conceptual mental models first, balanced engineering detail, or internals & trade-offs?`,
  ].join('\n');
}
