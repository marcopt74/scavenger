import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ONBOARDING_STAGES, PILLAR_TO_STAGE } from '../../shared/types.js';
import type {
  ChatMessage,
  CorePillarId,
  DiagnosticProfile,
  KnowledgeBaseStatus,
  LearningState,
  LearningTopic,
  OnboardingStage,
  ProviderSelection,
  RepoKnowledgeMap,
  RepoProgressSummary,
  RootReconSummary,
  SessionPublicState,
  SessionSummary,
  ToolActivity,
  TopicMastery,
  UserLevel,
} from '../../shared/types.js';
import { getDefaultProviderSelection } from '../config.js';
import { loadKnowledgeMap, toKnowledgeBaseStatus } from '../knowledge/knowledgeStore.js';
import {
  cloneLearningState,
  createInitialLearningState,
  makePillarTopicId,
} from './learningEngine.js';

export interface InternalSession {
  id: string;
  repoPath: string;
  repoName: string;
  currentStage: OnboardingStage;
  completedStages: Set<OnboardingStage>;
  diagnostic: DiagnosticProfile;
  learning: LearningState;
  rootRecon: RootReconSummary;
  knowledgeMap?: RepoKnowledgeMap;
  knowledgeStatus?: KnowledgeBaseStatus;
  provider: ProviderSelection;
  observedFiles: Set<string>;
  observedCommits: Set<string>;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

interface SerializedSession {
  version: 1;
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
  observedFiles: string[];
  observedCommits: string[];
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

const MASTERY_RANK: Record<TopicMastery, number> = {
  unexplored: 0,
  introduced: 1,
  developing: 2,
  solid: 3,
};

const MASTERY_POINTS: Record<TopicMastery, number> = {
  unexplored: 0,
  introduced: 35,
  developing: 70,
  solid: 100,
};

const SESSIONS_DIR_GITIGNORE_CONTENT = [
  '# Scavenger local onboarding session store',
  '# Auto-generated to guarantee session files are NEVER committed or pushed to Git.',
  '*',
  '!.gitignore',
  '',
].join('\n');

const sessions = new Map<string, InternalSession>();
let hydratedDirPath: string | null = null;

/**
 * Resolves the directory where onboarding sessions are persisted on disk.
 * Defaults to ~/.scavenger/sessions (outside any target repository).
 */
export function getSessionsDirPath(): string {
  const custom = process.env.SCAVENGER_SESSIONS_DIR?.trim();
  if (custom) {
    return path.resolve(custom);
  }
  if (process.env.VITEST) {
    return path.join(os.tmpdir(), `scavenger-vitest-sessions-${process.pid}`);
  }
  return path.join(os.homedir(), '.scavenger', 'sessions');
}

export function ensureSessionsDirSync(): string {
  const dir = getSessionsDirPath();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Ignore on platforms without POSIX chmod
  }

  const gitignorePath = path.join(dir, '.gitignore');
  try {
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, SESSIONS_DIR_GITIGNORE_CONTENT, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
  } catch {
    // Best-effort safeguard
  }

  return dir;
}

function getSessionFilePath(sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(getSessionsDirPath(), `${safeId}.json`);
}

export function resetSessionsCache(): void {
  sessions.clear();
  hydratedDirPath = null;
}

function deserializeSession(parsed: SerializedSession): InternalSession | null {
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.version !== 1 ||
    typeof parsed.id !== 'string' ||
    typeof parsed.repoPath !== 'string' ||
    !parsed.learning ||
    !Array.isArray(parsed.messages)
  ) {
    return null;
  }

  const knowledgeMap = loadKnowledgeMap(parsed.repoPath) ?? undefined;
  const knowledgeStatus =
    parsed.knowledgeStatus ??
    (knowledgeMap ? toKnowledgeBaseStatus(knowledgeMap, { lastRefreshTrigger: 'cached' }) : undefined);

  return {
    id: parsed.id,
    repoPath: path.resolve(parsed.repoPath),
    repoName: parsed.repoName || path.basename(parsed.repoPath),
    currentStage: parsed.currentStage ?? 0,
    completedStages: new Set<OnboardingStage>(
      Array.isArray(parsed.completedStages) ? parsed.completedStages : []
    ),
    diagnostic: parsed.diagnostic ?? {
      inferredLevel: 'uncalibrated',
      completed: false,
    },
    learning: cloneLearningState(parsed.learning),
    rootRecon: parsed.rootRecon,
    knowledgeMap,
    knowledgeStatus,
    provider: parsed.provider ?? getDefaultProviderSelection(),
    observedFiles: new Set<string>(Array.isArray(parsed.observedFiles) ? parsed.observedFiles : []),
    observedCommits: new Set<string>(
      Array.isArray(parsed.observedCommits) ? parsed.observedCommits : []
    ),
    messages: parsed.messages,
    createdAt: parsed.createdAt || new Date().toISOString(),
    updatedAt: parsed.updatedAt || parsed.createdAt || new Date().toISOString(),
  };
}

function hydrateSessionsFromDisk(): void {
  const dir = getSessionsDirPath();
  if (hydratedDirPath === dir) {
    return;
  }
  hydratedDirPath = dir;

  try {
    if (!fs.existsSync(dir)) {
      return;
    }
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const fullPath = path.join(dir, name);
      try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        const parsed = JSON.parse(raw) as SerializedSession;
        const session = deserializeSession(parsed);
        if (session && !sessions.has(session.id)) {
          sessions.set(session.id, session);
        }
      } catch {
        // Ignore corrupted file
      }
    }
  } catch {
    // Ignore read errors
  }
}

export function saveSession(session: InternalSession): string {
  const dir = ensureSessionsDirSync();
  const filePath = getSessionFilePath(session.id);
  const tmpPath = path.join(dir, `.sess.${crypto.randomBytes(6).toString('hex')}.tmp`);

  const payload: SerializedSession = {
    version: 1,
    id: session.id,
    repoPath: path.resolve(session.repoPath),
    repoName: session.repoName,
    currentStage: session.currentStage,
    completedStages: [...session.completedStages].sort((a, b) => a - b),
    diagnostic: { ...session.diagnostic },
    learning: cloneLearningState(session.learning),
    rootRecon: session.rootRecon,
    knowledgeStatus: session.knowledgeStatus ? { ...session.knowledgeStatus } : undefined,
    provider: { ...session.provider },
    observedFiles: [...session.observedFiles],
    observedCommits: [...session.observedCommits],
    messages: session.messages,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };

  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });

  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Ignore on non-POSIX
  }

  fs.renameSync(tmpPath, filePath);

  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Ignore on non-POSIX
  }

  sessions.set(session.id, session);
  return filePath;
}

export function computeTopicsProgressPercent(topics: LearningTopic[]): number {
  if (topics.length === 0) return 0;
  const totalPoints = topics.reduce((sum, t) => sum + (MASTERY_POINTS[t.mastery] ?? 0), 0);
  return Math.round(totalPoints / topics.length);
}

function mergeTopicsAcrossSessions(
  baseTopics: LearningTopic[],
  sessionList: InternalSession[]
): LearningTopic[] {
  const mergedMap = new Map<string, LearningTopic>();

  for (const t of baseTopics) {
    mergedMap.set(t.id, {
      ...t,
      relatedFiles: t.relatedFiles ? [...t.relatedFiles] : undefined,
    });
  }

  // Sort oldest to newest so newer notes/timestamps win while highest mastery is preserved
  const ordered = [...sessionList].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  for (const sess of ordered) {
    for (const topic of sess.learning.topics) {
      const key = topic.pillarId ? makePillarTopicId(topic.pillarId) : topic.id;
      const existing = mergedMap.get(key);
      if (!existing) {
        mergedMap.set(key, {
          ...topic,
          id: key,
          relatedFiles: topic.relatedFiles ? [...topic.relatedFiles] : undefined,
        });
      } else {
        const higherMastery =
          MASTERY_RANK[topic.mastery] >= MASTERY_RANK[existing.mastery]
            ? topic.mastery
            : existing.mastery;
        const combinedFiles = [
          ...(existing.relatedFiles ?? []),
          ...(topic.relatedFiles ?? []),
        ];
        mergedMap.set(key, {
          ...existing,
          title: topic.title || existing.title,
          mastery: higherMastery,
          notes: topic.notes ?? existing.notes,
          relatedFiles:
            combinedFiles.length > 0 ? [...new Set(combinedFiles)].slice(0, 12) : undefined,
          lastStudiedAt:
            topic.lastStudiedAt &&
            (!existing.lastStudiedAt || topic.lastStudiedAt > existing.lastStudiedAt)
              ? topic.lastStudiedAt
              : existing.lastStudiedAt,
        });
      }
    }
  }

  return [...mergedMap.values()];
}

export function createSession(
  rootRecon: RootReconSummary,
  providerOverride?: ProviderSelection,
  knowledgeOptions?: {
    knowledgeMap?: RepoKnowledgeMap;
    knowledgeStatus?: KnowledgeBaseStatus;
    startFresh?: boolean;
  }
): InternalSession {
  hydrateSessionsFromDisk();

  const canonicalRepoPath = path.resolve(rootRecon.repoPath);
  const priorRepoSessions = [...sessions.values()]
    .filter((s) => path.resolve(s.repoPath) === canonicalRepoPath)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  const id = `sess_${crypto.randomUUID().slice(0, 10)}`;
  const now = new Date().toISOString();
  const provider = providerOverride ?? getDefaultProviderSelection();
  const learning = createInitialLearningState(rootRecon);
  const knowledgeMap = knowledgeOptions?.knowledgeMap;
  const knowledgeStatus =
    knowledgeOptions?.knowledgeStatus ??
    (knowledgeMap ? toKnowledgeBaseStatus(knowledgeMap, { lastRefreshTrigger: 'initial' }) : undefined);

  const completedStages = new Set<OnboardingStage>();
  let diagnostic: DiagnosticProfile = {
    inferredLevel: 'uncalibrated',
    completed: false,
  };

  const observedFiles = new Set<string>();
  if (rootRecon.readmePath) observedFiles.add(rootRecon.readmePath);
  for (const m of rootRecon.manifests) observedFiles.add(m.path);
  for (const e of rootRecon.topLevelEntries) observedFiles.add(e.name);
  if (knowledgeMap) {
    for (const f of knowledgeMap.files) {
      observedFiles.add(f.path);
    }
  }

  const observedCommits = new Set<string>();
  for (const c of rootRecon.recentMilestones) {
    observedCommits.add(c.shortHash);
    observedCommits.add(c.hash);
  }
  if (knowledgeMap?.headCommit) {
    observedCommits.add(knowledgeMap.headCommit);
    observedCommits.add(knowledgeMap.headCommit.slice(0, 7));
  }

  let carriedOverTopicsCount = 0;

  if (priorRepoSessions.length > 0 && !knowledgeOptions?.startFresh) {
    learning.topics = mergeTopicsAcrossSessions(learning.topics, priorRepoSessions);

    for (const topic of learning.topics) {
      if (topic.pillarId && (topic.mastery === 'developing' || topic.mastery === 'solid')) {
        completedStages.add(PILLAR_TO_STAGE[topic.pillarId]);
      }
    }

    for (const prior of priorRepoSessions) {
      for (const stage of prior.completedStages) {
        completedStages.add(stage);
      }
      for (const f of prior.observedFiles) {
        observedFiles.add(f);
      }
      for (const c of prior.observedCommits) {
        observedCommits.add(c);
      }
      if (prior.diagnostic.completed && prior.diagnostic.inferredLevel !== 'uncalibrated') {
        diagnostic = {
          stackFamiliarity: prior.diagnostic.stackFamiliarity ?? diagnostic.stackFamiliarity,
          goal: prior.diagnostic.goal ?? diagnostic.goal,
          preferredDepth: prior.diagnostic.preferredDepth ?? diagnostic.preferredDepth,
          inferredLevel: prior.diagnostic.inferredLevel,
          completed: true,
        };
      }
    }

    carriedOverTopicsCount = learning.topics.filter(
      (t) => t.mastery === 'developing' || t.mastery === 'solid'
    ).length;

    if (carriedOverTopicsCount > 0 || diagnostic.completed) {
      learning.lastAssessmentSummary = `Restored cross-session progress from ${priorRepoSessions.length} previous session${priorRepoSessions.length === 1 ? '' : 's'}.`;
    }
  }

  const openingActivities: ToolActivity[] = [];

  if (knowledgeMap) {
    openingActivities.push({
      id: `act_${crypto.randomUUID().slice(0, 6)}`,
      toolName: 'query_knowledge_map',
      summary: `Built repository Knowledge Map (${knowledgeMap.stats.indexedFiles} files, ${knowledgeMap.stats.totalModules} modules, ${knowledgeMap.stats.totalSymbols} symbols, ${knowledgeMap.stats.totalEdges} edges)`,
      target: knowledgeMap.repoName,
      status: 'completed',
    });
  }

  openingActivities.push({
    id: `act_${crypto.randomUUID().slice(0, 6)}`,
    toolName: 'list_tree',
    summary: `Scanned root layout (${rootRecon.topLevelEntries.length} top-level entries)`,
    target: '.',
    status: 'completed',
  });

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
    content: buildStage0OpeningMessage(rootRecon, knowledgeMap, {
      priorSessionsCount: !knowledgeOptions?.startFresh ? priorRepoSessions.length : 0,
      carriedOverTopicsCount,
      inferredLevel: diagnostic.completed ? diagnostic.inferredLevel : undefined,
    }),
    createdAt: now,
    stage: 0,
    topicTitle: learning.activeTopicTitle,
    toolActivities: openingActivities,
    suggestedNextSteps: learning.suggestedNextSteps.map((s) => ({ ...s })),
  };

  const session: InternalSession = {
    id,
    repoPath: canonicalRepoPath,
    repoName: rootRecon.repoName,
    currentStage: 0,
    completedStages,
    diagnostic,
    learning,
    rootRecon: {
      ...rootRecon,
      repoPath: canonicalRepoPath,
    },
    knowledgeMap,
    knowledgeStatus,
    provider,
    observedFiles,
    observedCommits,
    messages: [openingMessage],
    createdAt: now,
    updatedAt: now,
  };

  saveSession(session);
  return session;
}

export function getSession(id: string): InternalSession | undefined {
  hydrateSessionsFromDisk();
  const cached = sessions.get(id);
  if (cached) {
    return cached;
  }

  // Fallback check if file was written after initial hydration
  const filePath = getSessionFilePath(id);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as SerializedSession;
      const loaded = deserializeSession(parsed);
      if (loaded) {
        sessions.set(loaded.id, loaded);
        return loaded;
      }
    }
  } catch {
    // Ignore
  }

  return undefined;
}

export function deleteSession(id: string): boolean {
  hydrateSessionsFromDisk();
  const existed = sessions.delete(id);
  const filePath = getSessionFilePath(id);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {
    // Ignore
  }
  return existed;
}

export function updateSessionKnowledge(
  session: InternalSession,
  knowledgeMap: RepoKnowledgeMap,
  knowledgeStatus: KnowledgeBaseStatus
): InternalSession {
  session.knowledgeMap = knowledgeMap;
  session.knowledgeStatus = knowledgeStatus;
  for (const f of knowledgeMap.files) {
    session.observedFiles.add(f.path);
  }
  if (knowledgeMap.headCommit) {
    session.observedCommits.add(knowledgeMap.headCommit);
    session.observedCommits.add(knowledgeMap.headCommit.slice(0, 7));
  }
  session.updatedAt = new Date().toISOString();
  saveSession(session);
  return session;
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
    session.diagnostic.completed = patch.inferredLevel !== 'uncalibrated';
  }
  if (patch.currentStage !== undefined) {
    session.currentStage = patch.currentStage;
  }
  if (patch.provider) {
    session.provider = patch.provider;
  }
  session.updatedAt = new Date().toISOString();
  saveSession(session);
  return session;
}

export function toSessionSummary(session: InternalSession): SessionSummary {
  const topics = session.learning.topics;
  const topicsExploredCount = topics.filter((t) => t.mastery !== 'unexplored').length;
  const solidTopicsCount = topics.filter((t) => t.mastery === 'solid').length;

  return {
    id: session.id,
    repoPath: session.repoPath,
    repoName: session.repoName,
    currentStage: session.currentStage,
    completedStages: [...session.completedStages].sort((a, b) => a - b),
    inferredLevel: session.diagnostic.inferredLevel,
    activeTopicId: session.learning.activeTopicId,
    activeTopicTitle: session.learning.activeTopicTitle,
    topicsExploredCount,
    solidTopicsCount,
    totalTopicsCount: topics.length,
    progressPercent: computeTopicsProgressPercent(topics),
    messageCount: session.messages.length,
    observedFilesCount: session.observedFiles.size,
    observedCommitsCount: session.observedCommits.size,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function listSessionSummaries(repoPathFilter?: string): SessionSummary[] {
  hydrateSessionsFromDisk();
  const normalizedFilter = repoPathFilter ? path.resolve(repoPathFilter) : null;
  const all = [...sessions.values()].filter((s) =>
    normalizedFilter ? path.resolve(s.repoPath) === normalizedFilter : true
  );
  return all
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((s) => toSessionSummary(s));
}

export function getRepoProgressSummaries(): RepoProgressSummary[] {
  hydrateSessionsFromDisk();
  const byRepo = new Map<string, InternalSession[]>();

  for (const session of sessions.values()) {
    const key = path.resolve(session.repoPath);
    const group = byRepo.get(key) ?? [];
    group.push(session);
    byRepo.set(key, group);
  }

  const summaries: RepoProgressSummary[] = [];

  for (const [repoPath, repoSessions] of byRepo.entries()) {
    const sortedDesc = [...repoSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const latest = sortedDesc[0];

    const basePillarTopics: LearningTopic[] = ONBOARDING_STAGES.map((stage) => ({
      id: makePillarTopicId(stage.pillarId),
      title: stage.title,
      kind: 'pillar',
      pillarId: stage.pillarId,
      mastery: 'unexplored',
    }));

    const mergedTopics = mergeTopicsAcrossSessions(basePillarTopics, repoSessions);
    const completedStagesSet = new Set<OnboardingStage>();
    const observedFilesSet = new Set<string>();
    const observedCommitsSet = new Set<string>();
    let totalMessagesCount = 0;
    let inferredLevel: UserLevel = latest.diagnostic.inferredLevel;

    for (const s of sortedDesc) {
      totalMessagesCount += s.messages.length;
      for (const st of s.completedStages) completedStagesSet.add(st);
      for (const f of s.observedFiles) observedFilesSet.add(f);
      for (const c of s.observedCommits) observedCommitsSet.add(c);
      if (inferredLevel === 'uncalibrated' && s.diagnostic.inferredLevel !== 'uncalibrated') {
        inferredLevel = s.diagnostic.inferredLevel;
      }
    }

    const pillarMasteries: Record<CorePillarId, TopicMastery> = {
      recon: 'unexplored',
      purpose: 'unexplored',
      architecture: 'unexplored',
      flows: 'unexplored',
      evolution: 'unexplored',
    };

    for (const topic of mergedTopics) {
      if (topic.pillarId) {
        pillarMasteries[topic.pillarId] = topic.mastery;
        if (topic.mastery === 'developing' || topic.mastery === 'solid') {
          completedStagesSet.add(PILLAR_TO_STAGE[topic.pillarId]);
        }
      }
    }

    const exploredTopicsCount = mergedTopics.filter((t) => t.mastery !== 'unexplored').length;
    const solidTopicsCount = mergedTopics.filter((t) => t.mastery === 'solid').length;

    summaries.push({
      repoPath,
      repoName: latest.repoName,
      sessionCount: repoSessions.length,
      lastSessionId: latest.id,
      lastUpdatedAt: latest.updatedAt,
      inferredLevel,
      completedStages: [...completedStagesSet].sort((a, b) => a - b),
      pillarMasteries,
      topics: mergedTopics,
      exploredTopicsCount,
      solidTopicsCount,
      totalTopicsCount: mergedTopics.length,
      progressPercent: computeTopicsProgressPercent(mergedTopics),
      totalMessagesCount,
      observedFilesCount: observedFilesSet.size,
      observedCommitsCount: observedCommitsSet.size,
    });
  }

  return summaries.sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt));
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
    knowledgeStatus: session.knowledgeStatus ? { ...session.knowledgeStatus } : undefined,
    provider: { ...session.provider },
    observedFilesCount: session.observedFiles.size,
    observedCommitsCount: session.observedCommits.size,
    messages: session.messages,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function buildStage0OpeningMessage(
  recon: RootReconSummary,
  knowledgeMap?: RepoKnowledgeMap,
  carryOver?: {
    priorSessionsCount: number;
    carriedOverTopicsCount: number;
    inferredLevel?: UserLevel;
  }
): string {
  const stackPhrase =
    recon.detectedStack.length > 0
      ? recon.detectedStack.slice(0, 5).join(', ')
      : 'a general codebase whose exact tooling we can unpack together';

  const topDirs = recon.topLevelEntries
    .filter((e) => e.type === 'dir')
    .slice(0, 5)
    .map((e) => `\`${e.name}/\``);

  const manifestNames = recon.manifests.map((m) => `\`${m.path}\``).slice(0, 4);

  const layoutSentence =
    topDirs.length > 0
      ? `At the root, the project separates its moving parts across ${topDirs.join(', ')}, anchored by ${manifestNames.length > 0 ? manifestNames.join(', ') : 'its top-level configuration files'}${recon.readmePath ? ` and documented in \`${recon.readmePath}\`` : ''}.`
      : `At the root, the repository keeps a compact layout anchored by ${manifestNames.length > 0 ? manifestNames.join(', ') : 'its top-level files'}${recon.readmePath ? ` and \`${recon.readmePath}\`` : ''}.`;

  const knowledgeSentence = knowledgeMap
    ? ` My pre-onboarding scanner also built a live **Repository Knowledge Map** indexing **${knowledgeMap.stats.indexedFiles} files**, **${knowledgeMap.stats.totalModules} modules**, **${knowledgeMap.stats.totalSymbols} exported symbols**, and **${knowledgeMap.stats.totalEdges} cross-file dependency edges**—so I can answer architectural and module questions right away and dive into specific code lines on demand.`
    : '';

  const gitSentence = recon.isGitRepo
    ? recon.recentMilestones.length > 0
      ? `Git history is live too—we're looking at branch \`${recon.branch ?? 'HEAD'}\`, with the latest milestone \`${recon.recentMilestones[0].shortHash}\` (*"${recon.recentMilestones[0].subject}"*) on ${recon.recentMilestones[0].date}, which means we can also trace *why* decisions evolved over time.`
      : `This folder is an initialized Git repository${recon.branch ? ` on \`${recon.branch}\`` : ''}, ready to inspect from the filesystem up.`
    : `There's no \`.git\` history in this directory, so we'll learn directly from the codebase structure and live file interactions.`;

  const carryOverNotice =
    carryOver && carryOver.priorSessionsCount > 0
      ? `\n\n> **Cross-Session Progress Restored:** I carried over your learning progress from **${carryOver.priorSessionsCount} previous session${carryOver.priorSessionsCount === 1 ? '' : 's'}** on \`${recon.repoName}\`${carryOver.inferredLevel ? ` (calibrated to **${carryOver.inferredLevel}** depth)` : ''}. Check the **Map** or **Sessions & Progress** menu in the top bar to jump straight to where you left off.`
      : '';

  return [
    `Welcome aboard! I just took a quick read-only walk around the root of **\`${recon.repoName}\`** so we can start from solid ground rather than guessing.`,
    '',
    `From the first glance, this looks like a **${stackPhrase}** repository. ${layoutSentence}${knowledgeSentence} ${gitSentence}${carryOverNotice}`,
    '',
    `Think of this session like a pair of engineers at a whiteboard: ==we'll start from clear mental models and work our way into how pieces depend on one another, how they behave over time, and the subtle details that usually trip newcomers up==.`,
    '',
    `Before I shape our first lesson, tell me a little about where you're starting from *(or skip straight ahead by clicking a topic below or naming anything you want to learn first)*:`,
    '',
    `1. **Comfort with the stack:** How familiar are you with ${recon.detectedStack.length > 0 ? recon.detectedStack.slice(0, 3).join(' / ') : 'these tools'}?`,
    `2. **What brings you here:** Are you orienting yourself, reviewing architecture, hunting a bug, or preparing to build a feature?`,
    `3. **How you like to learn:** Big-picture mental models first, balanced engineering walkthroughs, or deep internals and trade-offs?`,
  ].join('\n');
}
