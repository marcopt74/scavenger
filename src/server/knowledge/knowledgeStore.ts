import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  KnowledgeBaseStatus,
  KnowledgeRefreshTrigger,
  RepoKnowledgeMap,
} from '../../shared/types.js';

const memoryCache = new Map<string, RepoKnowledgeMap>();

const KNOWLEDGE_DIR_GITIGNORE_CONTENT = [
  '# Scavenger local repository knowledge cache',
  '# Auto-generated to guarantee knowledge files are NEVER committed or pushed to Git.',
  '*',
  '!.gitignore',
  '',
].join('\n');

/**
 * Resolves the directory where repository knowledge maps are persisted.
 * Defaults to ~/.scavenger/knowledge (outside any target repository).
 */
export function getKnowledgeDirPath(): string {
  const custom = process.env.SCAVENGER_KNOWLEDGE_DIR?.trim();
  if (custom) {
    return path.resolve(custom);
  }
  return path.join(os.homedir(), '.scavenger', 'knowledge');
}

/**
 * Ensures the knowledge directory exists with 0700 permissions and contains
 * a self-contained `.gitignore` (`*`) so knowledge folders can NEVER be committed or pushed.
 */
export function ensureKnowledgeDirSync(): string {
  const dir = getKnowledgeDirPath();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Ignore on platforms without POSIX chmod
  }

  const gitignorePath = path.join(dir, '.gitignore');
  try {
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, KNOWLEDGE_DIR_GITIGNORE_CONTENT, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
  } catch {
    // Best-effort safeguard
  }

  return dir;
}

/**
 * Computes a deterministic file path inside the knowledge store for a canonical repo path.
 */
export function getKnowledgeFilePath(canonicalRepoPath: string): string {
  const normalized = path.resolve(canonicalRepoPath);
  const slug =
    path
      .basename(normalized)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'repo';
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return path.join(getKnowledgeDirPath(), `${slug}-${hash}.json`);
}

export function resetKnowledgeCache(): void {
  memoryCache.clear();
}

export function loadKnowledgeMap(canonicalRepoPath: string): RepoKnowledgeMap | null {
  const normalized = path.resolve(canonicalRepoPath);
  const cached = memoryCache.get(normalized);
  if (cached) {
    return cached;
  }

  const filePath = getKnowledgeFilePath(normalized);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as RepoKnowledgeMap;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.files)) {
      return null;
    }
    memoryCache.set(normalized, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function saveKnowledgeMap(map: RepoKnowledgeMap): string {
  const normalized = path.resolve(map.repoPath);
  const dir = ensureKnowledgeDirSync();
  const filePath = getKnowledgeFilePath(normalized);
  const tmpPath = path.join(dir, `.km.${crypto.randomBytes(6).toString('hex')}.tmp`);

  const serialized = `${JSON.stringify(map, null, 2)}\n`;
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

  memoryCache.set(normalized, map);
  return filePath;
}

export function toKnowledgeBaseStatus(
  map: RepoKnowledgeMap,
  options?: {
    state?: KnowledgeBaseStatus['state'];
    currentRepoHead?: string;
    changedFilesCount?: number;
    commitsBehind?: number;
    lastRefreshTrigger?: KnowledgeRefreshTrigger;
    errorMessage?: string;
  }
): KnowledgeBaseStatus {
  const currentHead = options?.currentRepoHead ?? map.headCommit;
  const isStale = Boolean(
    map.headCommit && currentHead && map.headCommit !== currentHead
  );

  return {
    state: options?.state ?? (isStale ? 'stale' : 'ready'),
    headCommit: map.headCommit,
    currentRepoHead: currentHead,
    branch: map.branch,
    isStale,
    changedFilesCount: options?.changedFilesCount,
    commitsBehind: options?.commitsBehind,
    scannedAt: map.scannedAt,
    updatedAt: map.updatedAt,
    scanStrategy: map.scanStrategy,
    lastRefreshTrigger: options?.lastRefreshTrigger,
    stats: { ...map.stats },
    modules: map.modules.slice(0, 18).map((m) => ({
      id: m.id,
      name: m.name,
      path: m.path,
      role: m.role,
      layer: m.layer,
      fileCount: m.files.length,
      keySymbols: m.keySymbols.slice(0, 6),
    })),
    entryPoints: map.summary.entryPoints.slice(0, 10),
    coreFlows: map.summary.coreFlows.slice(0, 6),
    errorMessage: options?.errorMessage,
  };
}
