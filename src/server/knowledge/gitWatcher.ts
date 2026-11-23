import { runReadOnlyGit } from '../guardrails/gitGuard.js';
import { isGitRepository } from '../tools/gitTools.js';
import type { GitChangedFile } from './staticIndexer.js';

const HEX_SHA_REGEX = /^[0-9a-f]{7,40}$/i;

export interface RepoGitState {
  isGitRepo: boolean;
  headCommit?: string;
  branch?: string;
}

export interface RepoGitDiffSummary {
  canIncremental: boolean;
  fromCommit: string;
  toCommit: string;
  changedFiles: GitChangedFile[];
  commitsCount: number;
  commitSubjects: string[];
}

/**
 * Strictly read-only, lock-free inspection of the repository's current HEAD SHA and branch.
 */
export async function getRepoGitState(repoRoot: string): Promise<RepoGitState> {
  const isRepo = await isGitRepository(repoRoot);
  if (!isRepo) {
    return { isGitRepo: false };
  }

  let headCommit: string | undefined;
  let branch: string | undefined;

  try {
    const revRes = await runReadOnlyGit(repoRoot, 'rev-parse', ['HEAD']);
    const sha = revRes.stdout.trim().split('\n')[0]?.trim();
    if (sha && HEX_SHA_REGEX.test(sha)) {
      headCommit = sha;
    }
  } catch {
    // Repo might have zero commits
  }

  try {
    const branchRes = await runReadOnlyGit(repoRoot, 'branch', ['--show-current']);
    const b = branchRes.stdout.trim().split('\n')[0]?.trim();
    if (b) {
      branch = b;
    }
  } catch {
    // Detached HEAD or empty repo
  }

  return {
    isGitRepo: true,
    headCommit,
    branch,
  };
}

/**
 * Computes changed files and commit count between `fromCommit` and `toCommit` (e.g. after a `git pull`).
 * Strictly read-only via `runReadOnlyGit`.
 */
export async function computeGitDiffSince(
  repoRoot: string,
  fromCommit: string,
  toCommit: string
): Promise<RepoGitDiffSummary> {
  if (!HEX_SHA_REGEX.test(fromCommit) || !HEX_SHA_REGEX.test(toCommit)) {
    return {
      canIncremental: false,
      fromCommit,
      toCommit,
      changedFiles: [],
      commitsCount: 0,
      commitSubjects: [],
    };
  }

  if (fromCommit === toCommit) {
    return {
      canIncremental: true,
      fromCommit,
      toCommit,
      changedFiles: [],
      commitsCount: 0,
      commitSubjects: [],
    };
  }

  try {
    const diffRes = await runReadOnlyGit(repoRoot, 'diff', [
      '--name-status',
      `${fromCommit}..${toCommit}`,
    ]);

    const changedFiles: GitChangedFile[] = [];
    const lines = diffRes.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const rawStatus = parts[0].trim().toUpperCase();
      if (rawStatus.startsWith('R') && parts.length >= 3) {
        changedFiles.push({
          status: 'R',
          oldPath: parts[1].trim(),
          path: parts[2].trim(),
        });
      } else if (rawStatus.startsWith('D')) {
        changedFiles.push({
          status: 'D',
          path: parts[1].trim(),
        });
      } else if (rawStatus.startsWith('A')) {
        changedFiles.push({
          status: 'A',
          path: parts[1].trim(),
        });
      } else {
        changedFiles.push({
          status: 'M',
          path: parts[1].trim(),
        });
      }
    }

    let commitSubjects: string[] = [];
    try {
      const logRes = await runReadOnlyGit(repoRoot, 'log', [
        '--oneline',
        '-n',
        '30',
        `${fromCommit}..${toCommit}`,
      ]);
      commitSubjects = logRes.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      // Optional log subjects
    }

    return {
      canIncremental: true,
      fromCommit,
      toCommit,
      changedFiles,
      commitsCount: commitSubjects.length || 1,
      commitSubjects,
    };
  } catch {
    return {
      canIncremental: false,
      fromCommit,
      toCommit,
      changedFiles: [],
      commitsCount: 0,
      commitSubjects: [],
    };
  }
}
