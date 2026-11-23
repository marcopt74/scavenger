import { generateText } from 'ai';
import type {
  KnowledgeBaseStatus,
  KnowledgeRefreshTrigger,
  ProviderSelection,
  RepoCoreFlow,
  RepoKnowledgeMap,
  RepoModuleLayer,
  RootReconSummary,
  ScanPhase,
} from '../../shared/types.js';
import { getDefaultProviderSelection, resolveLanguageModel } from '../config.js';
import { validateRepoRoot } from '../guardrails/pathGuard.js';
import { runRootRecon } from '../tools/rootRecon.js';
import { computeGitDiffSince, getRepoGitState } from './gitWatcher.js';
import {
  loadKnowledgeMap,
  saveKnowledgeMap,
  toKnowledgeBaseStatus,
} from './knowledgeStore.js';
import {
  buildStaticKnowledgeMap,
  updateStaticIndexIncrementally,
} from './staticIndexer.js';

export interface ScanProgressCallbackPayload {
  phase: ScanPhase;
  message: string;
  percent: number;
  filesProcessed?: number;
  totalFiles?: number;
}

export interface ScanOrRefreshResult {
  knowledgeMap: RepoKnowledgeMap;
  status: KnowledgeBaseStatus;
  recon: RootReconSummary;
  refreshed: boolean;
  trigger: KnowledgeRefreshTrigger;
  changedFilesCount: number;
  commitsBehind: number;
}

/**
 * Scans a repository (or incrementally refreshes its cached Knowledge Map when git HEAD changes)
 * and persists the resulting RepoKnowledgeMap outside the target repository.
 */
export async function scanOrRefreshRepoKnowledge(
  rawRepoPath: string,
  options?: {
    recon?: RootReconSummary;
    provider?: ProviderSelection;
    forceFull?: boolean;
    trigger?: KnowledgeRefreshTrigger;
    skipLlmSynthesis?: boolean;
    onProgress?: (progress: ScanProgressCallbackPayload) => void;
  }
): Promise<ScanOrRefreshResult> {
  const repoRoot = await validateRepoRoot(rawRepoPath);

  options?.onProgress?.({
    phase: 'recon',
    message: 'Inspecting repository root, manifests, and git HEAD state…',
    percent: 6,
  });

  const [recon, gitState] = await Promise.all([
    options?.recon ? Promise.resolve(options.recon) : runRootRecon(repoRoot),
    getRepoGitState(repoRoot),
  ]);

  const cached = loadKnowledgeMap(repoRoot);
  const activeProvider = options?.provider ?? getDefaultProviderSelection();

  // 1. Reuse cached Knowledge Map when git HEAD is unchanged and forceFull is not requested
  if (cached && !options?.forceFull) {
    const headUnchanged =
      !gitState.isGitRepo ||
      !gitState.headCommit ||
      cached.headCommit === gitState.headCommit;

    if (headUnchanged) {
      options?.onProgress?.({
        phase: 'saving',
        message: `Loaded up-to-date Knowledge Map from cache (${cached.stats.indexedFiles} files, ${cached.stats.totalModules} modules).`,
        percent: 100,
        filesProcessed: cached.stats.indexedFiles,
        totalFiles: cached.stats.totalFiles,
      });

      const status = toKnowledgeBaseStatus(cached, {
        state: 'ready',
        currentRepoHead: gitState.headCommit,
        lastRefreshTrigger: 'cached',
      });

      return {
        knowledgeMap: cached,
        status,
        recon,
        refreshed: false,
        trigger: 'cached',
        changedFilesCount: 0,
        commitsBehind: 0,
      };
    }

    // 2. Git HEAD moved (e.g. after `git pull`) -> try incremental diff refresh
    if (cached.headCommit && gitState.headCommit && cached.headCommit !== gitState.headCommit) {
      options?.onProgress?.({
        phase: 'incremental-diff',
        message: `Detected git update (${cached.headCommit.slice(0, 7)} → ${gitState.headCommit.slice(0, 7)}) — computing changed files…`,
        percent: 15,
      });

      const diff = await computeGitDiffSince(repoRoot, cached.headCommit, gitState.headCommit);
      if (diff.canIncremental) {
        const updatedMap = await updateStaticIndexIncrementally(
          repoRoot,
          cached,
          recon,
          diff.changedFiles,
          {
            headCommit: gitState.headCommit,
            branch: gitState.branch ?? recon.branch,
            onProgress: (p) => options?.onProgress?.(p),
          }
        );

        // If new modules appeared and LLM synthesis is enabled, enrich new modules
        const prevModuleIds = new Set(cached.modules.map((m) => m.id));
        const hasNewModules = updatedMap.modules.some((m) => !prevModuleIds.has(m.id));
        if (hasNewModules && !options?.skipLlmSynthesis) {
          options?.onProgress?.({
            phase: 'synthesis',
            message: 'Updating architecture synthesis for newly added modules…',
            percent: 82,
          });
          await enrichKnowledgeMapWithLlm(updatedMap, recon, activeProvider);
        }

        options?.onProgress?.({
          phase: 'saving',
          message: `Saved incrementally refreshed Knowledge Map (${diff.changedFiles.length} changed file${diff.changedFiles.length === 1 ? '' : 's'}).`,
          percent: 96,
        });

        saveKnowledgeMap(updatedMap);
        const trigger: KnowledgeRefreshTrigger = options?.trigger ?? 'git-pull-auto';
        const status = toKnowledgeBaseStatus(updatedMap, {
          state: 'ready',
          currentRepoHead: gitState.headCommit,
          changedFilesCount: diff.changedFiles.length,
          commitsBehind: 0,
          lastRefreshTrigger: trigger,
        });

        return {
          knowledgeMap: updatedMap,
          status,
          recon,
          refreshed: true,
          trigger,
          changedFilesCount: diff.changedFiles.length,
          commitsBehind: diff.commitsCount,
        };
      }
    }
  }

  // 3. Full repository scan (initial onboarding or manual full refresh)
  const fullStartTime = Date.now();
  const staticMap = await buildStaticKnowledgeMap(repoRoot, recon, {
    headCommit: gitState.headCommit,
    branch: gitState.branch ?? recon.branch,
    onProgress: (p) => options?.onProgress?.(p),
  });

  if (!options?.skipLlmSynthesis) {
    options?.onProgress?.({
      phase: 'synthesis',
      message: 'Scanner agent synthesizing module responsibilities and core execution flows…',
      percent: 80,
      filesProcessed: staticMap.stats.indexedFiles,
      totalFiles: staticMap.stats.totalFiles,
    });

    await enrichKnowledgeMapWithLlm(staticMap, recon, activeProvider);
  }

  staticMap.stats.durationMs = Date.now() - fullStartTime;

  options?.onProgress?.({
    phase: 'saving',
    message: 'Persisting Knowledge Map to local cache…',
    percent: 95,
    filesProcessed: staticMap.stats.indexedFiles,
    totalFiles: staticMap.stats.totalFiles,
  });

  saveKnowledgeMap(staticMap);

  const trigger: KnowledgeRefreshTrigger = options?.trigger ?? 'initial';
  const status = toKnowledgeBaseStatus(staticMap, {
    state: 'ready',
    currentRepoHead: gitState.headCommit,
    changedFilesCount: 0,
    commitsBehind: 0,
    lastRefreshTrigger: trigger,
  });

  return {
    knowledgeMap: staticMap,
    status,
    recon,
    refreshed: true,
    trigger,
    changedFilesCount: 0,
    commitsBehind: 0,
  };
}

interface LlmSynthesisShape {
  purpose?: string;
  architectureOverview?: string;
  conventions?: string[];
  modules?: Array<{
    id: string;
    role: string;
    layer?: RepoModuleLayer;
  }>;
  coreFlows?: Array<{
    id?: string;
    name: string;
    summary: string;
    files: string[];
    steps: string[];
  }>;
}

async function enrichKnowledgeMapWithLlm(
  map: RepoKnowledgeMap,
  recon: RootReconSummary,
  provider: ProviderSelection
): Promise<void> {
  const model = resolveLanguageModel(provider);
  if (!model) {
    return;
  }

  const compactModules = map.modules.slice(0, 20).map((m) => ({
    id: m.id,
    layer: m.layer,
    files: m.files.slice(0, 8),
    dependsOn: m.dependsOnModules,
    dependedOnBy: m.dependedOnByModules,
    keySymbols: m.keySymbols.slice(0, 8),
  }));

  const compactEntries = map.summary.entryPoints.slice(0, 10);

  const prompt = [
    `You are the Scavenger Repository Scanner Agent. Analyze this deterministic static index of "${recon.repoName}" and return ONLY a valid JSON object (no markdown fences, no commentary) synthesizing the repository's architecture.`,
    '',
    `Detected Stack: ${recon.detectedStack.join(', ') || 'General'}`,
    `README Excerpt:\n${(recon.readmeExcerpt ?? 'None').slice(0, 1200)}`,
    `Entry Points:\n${JSON.stringify(compactEntries, null, 2)}`,
    `Indexed Modules (${map.modules.length}):\n${JSON.stringify(compactModules, null, 2)}`,
    '',
    `Return JSON matching this exact structure:`,
    `{`,
    `  "purpose": "2-3 sentence summary of what the repo does, who it serves, and its domain boundaries",`,
    `  "architectureOverview": "2-3 sentence architectural mental model explaining how the major layers and modules collaborate",`,
    `  "conventions": ["up to 4 concrete engineering or safety conventions observed"],`,
    `  "modules": [{ "id": "exact module id from input", "role": "concise 1-sentence responsibility of this module" }],`,
    `  "coreFlows": [{ "id": "flow-slug", "name": "Flow Name", "summary": "1-sentence summary", "files": ["grounded/file/path.ts"], "steps": ["Step 1...", "Step 2..."] }]`,
    `}`,
  ].join('\n');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18_000);
    try {
      const result = await generateText({
        model,
        prompt,
        temperature: 0.2,
        abortSignal: controller.signal,
      });

      const parsed = parseJsonFromText(result.text);
      if (!parsed) return;

      if (typeof parsed.purpose === 'string' && parsed.purpose.trim().length > 15) {
        map.summary.purpose = parsed.purpose.trim();
      }
      if (
        typeof parsed.architectureOverview === 'string' &&
        parsed.architectureOverview.trim().length > 15
      ) {
        map.summary.architectureOverview = parsed.architectureOverview.trim();
      }
      if (Array.isArray(parsed.conventions) && parsed.conventions.length > 0) {
        map.summary.conventions = parsed.conventions
          .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
          .slice(0, 6);
      }
      if (Array.isArray(parsed.modules)) {
        const roleById = new Map<string, string>();
        for (const m of parsed.modules) {
          if (m && typeof m.id === 'string' && typeof m.role === 'string' && m.role.trim()) {
            roleById.set(m.id.trim(), m.role.trim());
          }
        }
        for (const mod of map.modules) {
          const synthesizedRole = roleById.get(mod.id);
          if (synthesizedRole) {
            mod.role = synthesizedRole;
          }
        }
      }
      if (Array.isArray(parsed.coreFlows) && parsed.coreFlows.length > 0) {
        const knownFiles = new Set(map.files.map((f) => f.path));
        const validFlows: RepoCoreFlow[] = [];
        for (const f of parsed.coreFlows.slice(0, 5)) {
          if (!f || typeof f.name !== 'string' || typeof f.summary !== 'string') continue;
          const groundedFiles = Array.isArray(f.files)
            ? f.files.filter((p): p is string => typeof p === 'string' && knownFiles.has(p))
            : [];
          const steps = Array.isArray(f.steps)
            ? f.steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            : [];
          if (groundedFiles.length > 0 || steps.length > 0) {
            validFlows.push({
              id:
                typeof f.id === 'string' && f.id.trim()
                  ? f.id.trim()
                  : `flow:${f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
              name: f.name.trim(),
              summary: f.summary.trim(),
              files: groundedFiles,
              steps: steps.slice(0, 6),
            });
          }
        }
        if (validFlows.length > 0) {
          map.summary.coreFlows = validFlows;
        }
      }

      map.scanStrategy = 'hybrid';
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Graceful fallback to static synthesis
  }
}

function parseJsonFromText(raw: string): LlmSynthesisShape | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as LlmSynthesisShape;
  } catch {
    return null;
  }
}

/**
 * Formats a token-efficient digest of the Repository Knowledge Map for the onboarding agent's system prompt.
 */
export function formatKnowledgeMapDigest(map: RepoKnowledgeMap): string {
  const moduleLines = map.modules
    .slice(0, 18)
    .map((m) => {
      const deps =
        m.dependsOnModules.length > 0 ? ` → depends on: ${m.dependsOnModules.join(', ')}` : '';
      const revDeps =
        m.dependedOnByModules.length > 0
          ? ` ← used by: ${m.dependedOnByModules.join(', ')}`
          : '';
      const syms =
        m.keySymbols.length > 0 ? ` | exports: ${m.keySymbols.slice(0, 6).join(', ')}` : '';
      return `- **\`${m.id}\`** [${m.layer}, ${m.files.length} files]: ${m.role}${deps}${revDeps}${syms}`;
    })
    .join('\n');

  const entryLines =
    map.summary.entryPoints.length > 0
      ? map.summary.entryPoints
          .slice(0, 8)
          .map((e) => `- \`${e.path}\` (${e.kind}): ${e.role}`)
          .join('\n')
      : '- None detected.';

  const flowLines =
    map.summary.coreFlows.length > 0
      ? map.summary.coreFlows
          .slice(0, 5)
          .map(
            (f) =>
              `- **${f.name}** (\`${f.id}\`): ${f.summary} (files: ${f.files.map((p) => `\`${p}\``).join(' → ')})`
          )
          .join('\n')
      : '- None indexed.';

  return [
    `## Pre-Scanned Repository Knowledge Map (${map.stats.indexedFiles} files, ${map.stats.totalModules} modules, ${map.stats.totalSymbols} symbols, ${map.stats.totalEdges} dependency edges${map.headCommit ? `, HEAD @ ${map.headCommit.slice(0, 7)}` : ''})`,
    '',
    `### Synthesized Purpose`,
    map.summary.purpose,
    '',
    `### Architecture Overview`,
    map.summary.architectureOverview,
    '',
    `### Module Map & Interdependencies`,
    moduleLines || 'No modules indexed.',
    '',
    `### Key Entry Points`,
    entryLines,
    '',
    `### Core Execution Flows`,
    flowLines,
  ].join('\n');
}

export interface KnowledgeQueryInput {
  queryType: 'overview' | 'module' | 'symbol' | 'file' | 'dependents' | 'flow';
  target?: string;
}

/**
 * Instant in-memory query over the pre-scanned RepoKnowledgeMap.
 */
export function queryKnowledgeMap(map: RepoKnowledgeMap, input: KnowledgeQueryInput) {
  const q = (input.target ?? '').trim().toLowerCase();

  switch (input.queryType) {
    case 'overview':
      return {
        repoName: map.repoName,
        headCommit: map.headCommit,
        branch: map.branch,
        stats: map.stats,
        summary: map.summary,
        modules: map.modules.map((m) => ({
          id: m.id,
          layer: m.layer,
          role: m.role,
          fileCount: m.files.length,
          dependsOnModules: m.dependsOnModules,
          dependedOnByModules: m.dependedOnByModules,
          keySymbols: m.keySymbols.slice(0, 8),
        })),
      };

    case 'module': {
      const matched = map.modules.filter(
        (m) =>
          !q ||
          m.id.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          m.role.toLowerCase().includes(q)
      );
      return {
        matchedCount: matched.length,
        modules: matched.slice(0, 8).map((m) => ({
          ...m,
          fileDetails: map.files
            .filter((f) => f.moduleId === m.id)
            .slice(0, 20)
            .map((f) => ({
              path: f.path,
              lines: f.lines,
              roleSummary: f.roleSummary,
              exports: f.exports.map((e) => `${e.name} (${e.kind} @ L${e.line})`),
              importsFromRepo: f.imports
                .map((i) => i.resolvedPath)
                .filter((p): p is string => Boolean(p)),
            })),
        })),
      };
    }

    case 'symbol': {
      const matches: Array<{
        symbol: string;
        kind: string;
        path: string;
        line: number;
        moduleId: string;
      }> = [];
      for (const file of map.files) {
        for (const exp of file.exports) {
          if (!q || exp.name.toLowerCase().includes(q)) {
            matches.push({
              symbol: exp.name,
              kind: exp.kind,
              path: file.path,
              line: exp.line,
              moduleId: file.moduleId,
            });
          }
        }
      }
      return {
        query: input.target,
        matchCount: matches.length,
        matches: matches.slice(0, 30),
      };
    }

    case 'file': {
      const matchedFiles = map.files.filter(
        (f) => !q || f.path.toLowerCase().includes(q)
      );
      return {
        query: input.target,
        matchCount: matchedFiles.length,
        files: matchedFiles.slice(0, 10).map((f) => ({
          ...f,
          importedByFiles: map.dependencyEdges
            .filter((e) => e.to === f.path)
            .map((e) => e.from),
          importsRepoFiles: map.dependencyEdges
            .filter((e) => e.from === f.path)
            .map((e) => e.to),
        })),
      };
    }

    case 'dependents': {
      const incoming = map.dependencyEdges.filter(
        (e) => !q || e.to.toLowerCase().includes(q)
      );
      const outgoing = map.dependencyEdges.filter(
        (e) => !q || e.from.toLowerCase().includes(q)
      );
      return {
        target: input.target,
        dependedOnBy: incoming.slice(0, 30),
        dependsOn: outgoing.slice(0, 30),
      };
    }

    case 'flow': {
      const flows = map.summary.coreFlows.filter(
        (f) =>
          !q ||
          f.id.toLowerCase().includes(q) ||
          f.name.toLowerCase().includes(q) ||
          f.summary.toLowerCase().includes(q) ||
          f.files.some((p) => p.toLowerCase().includes(q))
      );
      return {
        query: input.target,
        flows: flows.length > 0 ? flows : map.summary.coreFlows,
      };
    }
  }
}
