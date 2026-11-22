import { runReadOnlyGit } from '../guardrails/gitGuard.js';

export interface GitInspectResult {
  isGitRepo: boolean;
  command: string;
  output: string;
  truncated: boolean;
  observedCommits: string[];
}

const MAX_OUTPUT_CHARS = 16_000;
const COMMIT_HASH_REGEX = /\b[0-9a-f]{7,40}\b/g;

export async function isGitRepository(repoRoot: string): Promise<boolean> {
  try {
    const res = await runReadOnlyGit(repoRoot, 'rev-parse', ['--is-inside-work-tree']);
    return res.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function gitInspect(
  repoRoot: string,
  options: {
    subcommand: string;
    args?: string[];
  }
): Promise<GitInspectResult> {
  const isRepo = await isGitRepository(repoRoot);
  if (!isRepo) {
    return {
      isGitRepo: false,
      command: `git ${options.subcommand} ${(options.args ?? []).join(' ')}`.trim(),
      output: 'Target directory is not a Git repository.',
      truncated: false,
      observedCommits: [],
    };
  }

  const result = await runReadOnlyGit(repoRoot, options.subcommand, options.args ?? []);
  const combined = result.stdout || result.stderr || '(no output)';
  const truncated = combined.length > MAX_OUTPUT_CHARS;
  const output = truncated
    ? `${combined.slice(0, MAX_OUTPUT_CHARS)}\n... (output truncated at ${MAX_OUTPUT_CHARS} chars)`
    : combined;

  const commitMatches = new Set<string>();
  if (['log', 'show', 'blame', 'rev-parse'].includes(options.subcommand)) {
    const matches = output.match(COMMIT_HASH_REGEX) ?? [];
    for (const sha of matches.slice(0, 40)) {
      commitMatches.add(sha);
    }
  }

  return {
    isGitRepo: true,
    command: result.command,
    output: output.trim(),
    truncated,
    observedCommits: [...commitMatches],
  };
}
