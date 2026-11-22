import fs from 'node:fs/promises';
import path from 'node:path';

export class GuardrailViolationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GuardrailViolationError';
    this.code = code;
  }
}

export const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.turbo',
  '.cache',
  'coverage',
  '.pnpm-store',
  '.idea',
  '.vscode',
]);

export const MAX_READ_BYTES = 256 * 1024; // 256 KB per file read

export interface SafePathResult {
  absolutePath: string;
  relativePath: string;
  repoRoot: string;
}

/**
 * Validates that a target directory exists and returns its canonical realpath.
 */
export async function validateRepoRoot(rawRepoPath: string): Promise<string> {
  if (typeof rawRepoPath !== 'string' || rawRepoPath.trim().length === 0) {
    throw new GuardrailViolationError('INVALID_REPO_PATH', 'Repository path must be a non-empty string.');
  }
  if (rawRepoPath.includes('\0')) {
    throw new GuardrailViolationError('NULL_BYTE_PATH', 'Repository path contains forbidden null bytes.');
  }

  const expanded = rawRepoPath.trim().startsWith('~')
    ? path.join(process.env.HOME ?? '', rawRepoPath.trim().slice(1))
    : rawRepoPath.trim();

  const resolved = path.resolve(expanded);
  let stats;
  try {
    stats = await fs.stat(resolved);
  } catch {
    throw new GuardrailViolationError('REPO_NOT_FOUND', `Repository path does not exist: ${rawRepoPath}`);
  }

  if (!stats.isDirectory()) {
    throw new GuardrailViolationError('REPO_NOT_DIRECTORY', `Repository path is not a directory: ${rawRepoPath}`);
  }

  return fs.realpath(resolved);
}

function isInsideRoot(canonicalRoot: string, candidatePath: string): boolean {
  if (candidatePath === canonicalRoot) {
    return true;
  }
  const prefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
  return candidatePath.startsWith(prefix);
}

/**
 * Resolves a path strictly inside `canonicalRepoRoot`, blocking `..` traversal,
 * absolute escapes, symlink escapes outside the repo, null bytes, and `.git/` internals.
 */
export async function resolveSafeRepoPath(
  canonicalRepoRoot: string,
  inputPath = '.',
  options?: { allowDotGit?: boolean }
): Promise<SafePathResult> {
  if (typeof inputPath !== 'string') {
    throw new GuardrailViolationError('INVALID_PATH', 'Target path must be a string.');
  }
  if (inputPath.includes('\0')) {
    throw new GuardrailViolationError('NULL_BYTE_PATH', 'Path contains forbidden null bytes.');
  }

  const trimmed = inputPath.trim() === '' ? '.' : inputPath.trim();
  const normalizedRoot = await fs.realpath(canonicalRepoRoot);

  // Resolve relative to repo root (if absolute, must still lie inside normalizedRoot)
  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(normalizedRoot, trimmed);

  if (!isInsideRoot(normalizedRoot, candidate)) {
    throw new GuardrailViolationError(
      'PATH_ESCAPE',
      `Access denied: "${inputPath}" resolves outside the target repository boundary.`
    );
  }

  // Check logical relative path for .git access before resolving symlinks
  const logicalRel = path.relative(normalizedRoot, candidate);
  if (!options?.allowDotGit && isDotGitPath(logicalRel)) {
    throw new GuardrailViolationError(
      'DOT_GIT_BLOCKED',
      `Direct filesystem access to ".git" internals is blocked; use read-only git inspection instead.`
    );
  }

  // Resolve symlinks to prevent symlink-based escape outside repo root
  let realCandidate: string;
  try {
    realCandidate = await fs.realpath(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new GuardrailViolationError('PATH_NOT_FOUND', `Path does not exist inside repository: ${inputPath}`);
    }
    throw new GuardrailViolationError('PATH_UNREADABLE', `Cannot access path: ${inputPath}`);
  }

  if (!isInsideRoot(normalizedRoot, realCandidate)) {
    throw new GuardrailViolationError(
      'SYMLINK_ESCAPE',
      `Access denied: "${inputPath}" resolves via symlink outside the target repository.`
    );
  }

  const relativePath = path.relative(normalizedRoot, realCandidate) || '.';
  if (!options?.allowDotGit && isDotGitPath(relativePath)) {
    throw new GuardrailViolationError(
      'DOT_GIT_BLOCKED',
      `Direct filesystem access to ".git" internals is blocked; use read-only git inspection instead.`
    );
  }

  return {
    absolutePath: realCandidate,
    relativePath,
    repoRoot: normalizedRoot,
  };
}

function isDotGitPath(relPath: string): boolean {
  if (!relPath || relPath === '.') return false;
  const segments = relPath.split(path.sep);
  return segments.includes('.git');
}

export function isLikelyBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8192);
  if (sampleLength === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < sampleLength; i++) {
    const byte = buffer[i];
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) {
      nonPrintable++;
    }
  }
  return nonPrintable / sampleLength > 0.15;
}
