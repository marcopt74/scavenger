import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  DirectoryBreadcrumb,
  DirectoryBrowseResponse,
  DirectoryEntry,
  DirectoryShortcut,
} from '../../shared/types.js';

export type DirectoryBrowseErrorCode =
  | 'INVALID_PATH'
  | 'NOT_FOUND'
  | 'NOT_DIRECTORY'
  | 'PERMISSION_DENIED'
  | 'READ_FAILED';

export type DirectoryBrowseHttpStatus = 400 | 403 | 404 | 500;

export class DirectoryBrowseError extends Error {
  readonly code: DirectoryBrowseErrorCode;
  readonly status: DirectoryBrowseHttpStatus;

  constructor(code: DirectoryBrowseErrorCode, status: DirectoryBrowseHttpStatus, message: string) {
    super(message);
    this.name = 'DirectoryBrowseError';
    this.code = code;
    this.status = status;
  }
}

export const DEFAULT_MAX_BROWSE_ENTRIES = 500;

export interface BrowseDirectoryOptions {
  targetPath?: string;
  showHidden?: boolean;
  fallbackToNearestParent?: boolean;
  maxEntries?: number;
}

/**
 * Expands leading `~`, `~/`, or `~\` to the current user's home directory.
 */
function expandHomeDir(rawPath: string): string {
  const trimmed = rawPath.trim();
  const home = os.homedir();
  if (trimmed === '~') {
    return home;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(home, trimmed.slice(2));
  }
  return trimmed;
}

async function isReadableDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) return false;
    await fs.access(dirPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether a directory looks like a Git repository by testing for `.git`
 * (either a directory for standard repos or a file for worktrees/submodules).
 * Strictly read-only, zero child processes, zero lockfiles.
 */
async function hasGitMarker(dirPath: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(dirPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function resolveDefaultStartDir(): Promise<string> {
  const candidates = [os.homedir(), process.cwd(), path.parse(process.cwd()).root];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return await fs.realpath(candidate);
      }
    } catch {
      // try next fallback
    }
  }
  throw new DirectoryBrowseError('READ_FAILED', 500, 'Unable to determine a readable starting directory.');
}

async function resolveTargetDirectory(
  rawPath: string | undefined,
  fallbackToNearestParent: boolean
): Promise<string> {
  if (rawPath !== undefined && rawPath.includes('\0')) {
    throw new DirectoryBrowseError('INVALID_PATH', 400, 'Directory path contains forbidden null bytes.');
  }

  const trimmed = rawPath?.trim() ?? '';
  if (!trimmed) {
    return resolveDefaultStartDir();
  }

  const resolved = path.resolve(expandHomeDir(trimmed));

  if (!fallbackToNearestParent) {
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new DirectoryBrowseError(
          'PERMISSION_DENIED',
          403,
          `Permission denied: cannot access "${trimmed}".`
        );
      }
      throw new DirectoryBrowseError('NOT_FOUND', 404, `Directory does not exist: ${trimmed}`);
    }

    if (!stat.isDirectory()) {
      throw new DirectoryBrowseError(
        'NOT_DIRECTORY',
        400,
        `Path is a file, not a directory: ${trimmed}`
      );
    }

    try {
      return await fs.realpath(resolved);
    } catch {
      return resolved;
    }
  }

  // Fallback mode: walk upward until we reach an existing readable directory
  let candidate = resolved;
  for (let depth = 0; depth < 64; depth++) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        try {
          return await fs.realpath(candidate);
        } catch {
          return candidate;
        }
      }
    } catch {
      // Walk up to parent
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }

  return resolveDefaultStartDir();
}

export function buildBreadcrumbs(canonicalPath: string): DirectoryBreadcrumb[] {
  const parsed = path.parse(canonicalPath);
  const root = parsed.root;
  const crumbs: DirectoryBreadcrumb[] = [{ name: root, path: root }];

  const remainder = canonicalPath.slice(root.length);
  if (!remainder) {
    return crumbs;
  }

  const segments = remainder.split(path.sep).filter(Boolean);
  let acc = root;
  for (const segment of segments) {
    acc = path.join(acc, segment);
    crumbs.push({ name: segment, path: acc });
  }

  return crumbs;
}

async function getDirectoryShortcuts(): Promise<DirectoryShortcut[]> {
  const home = os.homedir();
  const cwd = process.cwd();
  const root = path.parse(home || cwd).root;

  const candidates: Array<{ label: string; rawPath: string; kind: DirectoryShortcut['kind'] }> = [
    { label: 'Home', rawPath: home, kind: 'home' },
    { label: 'Workspace', rawPath: cwd, kind: 'workspace' },
    { label: 'Desktop', rawPath: path.join(home, 'Desktop'), kind: 'folder' },
    { label: 'Documents', rawPath: path.join(home, 'Documents'), kind: 'folder' },
  ];

  if (process.platform === 'win32') {
    const driveLetters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const driveChecks = await Promise.all(
      driveLetters.map(async (letter) => {
        const drivePath = `${letter}:\\`;
        const ok = await isReadableDirectory(drivePath);
        return ok ? { label: `${letter}:`, rawPath: drivePath, kind: 'root' as const } : null;
      })
    );
    for (const drive of driveChecks) {
      if (drive) candidates.push(drive);
    }
  } else if (root) {
    candidates.push({ label: 'Root', rawPath: root, kind: 'root' });
  }

  const shortcuts: DirectoryShortcut[] = [];
  const seen = new Set<string>();

  for (const item of candidates) {
    if (!item.rawPath) continue;
    try {
      const stat = await fs.stat(item.rawPath);
      if (!stat.isDirectory()) continue;
      const canonical = await fs.realpath(item.rawPath).catch(() => path.resolve(item.rawPath));
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      shortcuts.push({
        label: item.label,
        path: canonical,
        kind: item.kind,
      });
    } catch {
      // Skip non-existent or inaccessible shortcut
    }
  }

  return shortcuts;
}

/**
 * Strictly read-only directory browser for picking a local repository folder.
 * Lists subdirectories (never reads file contents) and detects `.git` markers.
 */
export async function browseDirectory(
  options?: BrowseDirectoryOptions
): Promise<DirectoryBrowseResponse> {
  const showHidden = options?.showHidden ?? false;
  const fallbackToNearestParent = options?.fallbackToNearestParent ?? false;
  const maxEntries = Math.min(Math.max(options?.maxEntries ?? DEFAULT_MAX_BROWSE_ENTRIES, 1), 1000);

  const currentPath = await resolveTargetDirectory(options?.targetPath, fallbackToNearestParent);
  const rawParent = path.dirname(currentPath);
  const parentPath = rawParent === currentPath ? null : rawParent;

  let dirents;
  try {
    dirents = await fs.readdir(currentPath, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new DirectoryBrowseError(
        'PERMISSION_DENIED',
        403,
        `Permission denied: cannot read "${currentPath}".`
      );
    }
    throw new DirectoryBrowseError(
      'READ_FAILED',
      500,
      `Unable to read directory "${currentPath}".`
    );
  }

  let fileCount = 0;
  const rawDirs: Array<{ name: string; fullPath: string; isHidden: boolean; isSymlink: boolean }> =
    [];

  for (const dirent of dirents) {
    const name = dirent.name;
    const isHidden = name.startsWith('.');
    const fullPath = path.join(currentPath, name);

    if (dirent.isDirectory()) {
      if (!showHidden && isHidden) continue;
      rawDirs.push({ name, fullPath, isHidden, isSymlink: false });
      continue;
    }

    if (dirent.isSymbolicLink()) {
      try {
        const targetStat = await fs.stat(fullPath);
        if (targetStat.isDirectory()) {
          if (!showHidden && isHidden) continue;
          rawDirs.push({ name, fullPath, isHidden, isSymlink: true });
        } else if (targetStat.isFile()) {
          if (showHidden || !isHidden) fileCount++;
        }
      } catch {
        // Broken or permission-denied symlink — safely skip
      }
      continue;
    }

    if (dirent.isFile()) {
      if (showHidden || !isHidden) fileCount++;
    }
  }

  rawDirs.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );

  const truncated = rawDirs.length > maxEntries;
  const slicedDirs = truncated ? rawDirs.slice(0, maxEntries) : rawDirs;

  const [isCurrentGitRepo, shortcuts, entries] = await Promise.all([
    hasGitMarker(currentPath),
    getDirectoryShortcuts(),
    Promise.all(
      slicedDirs.map(async (dir): Promise<DirectoryEntry> => ({
        name: dir.name,
        path: dir.fullPath,
        isGitRepo: await hasGitMarker(dir.fullPath),
        isHidden: dir.isHidden,
        isSymlink: dir.isSymlink,
      }))
    ),
  ]);

  return {
    currentPath,
    parentPath,
    isCurrentGitRepo,
    breadcrumbs: buildBreadcrumbs(currentPath),
    entries,
    fileCount,
    truncated,
    shortcuts,
  };
}
