import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GuardrailViolationError, validateRepoRoot } from './pathGuard.js';

const execFileAsync = promisify(execFile);

export const ALLOWED_GIT_SUBCOMMANDS = [
  'log',
  'show',
  'diff',
  'blame',
  'shortlog',
  'status',
  'rev-parse',
  'branch',
  'tag',
  'ls-files',
] as const;

export type AllowedGitSubcommand = (typeof ALLOWED_GIT_SUBCOMMANDS)[number];

const ALLOWED_SET = new Set<string>(ALLOWED_GIT_SUBCOMMANDS);

const FORBIDDEN_GLOBAL_OR_DANGEROUS_FLAGS = new Set([
  '-c',
  '-C',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--exec-path',
  '--namespace',
  '--super-prefix',
  '--output',
  '--ext-diff',
  '--textconv',
  '--exec',
  '--upload-pack',
  '--receive-pack',
  '--delete',
  '--force',
  '--move',
  '--copy',
  '--edit-description',
  '--set-upstream-to',
  '--unset-upstream',
  '--create-reflog',
  '--annotate',
  '--sign',
  '--local-user',
  '--cleanup',
  '--file',
  '--message',
  '--write-tree',
]);

const FORBIDDEN_FLAG_PREFIXES = [
  '--output=',
  '--git-dir=',
  '--work-tree=',
  '--exec-path=',
  '--config-env=',
  '--exec=',
  '--set-upstream-to=',
  '--message=',
  '--file=',
  '-c',
];

const BRANCH_MUTATING_SHORT_FLAGS = new Set(['-d', '-D', '-m', '-M', '-c', '-C', '-f', '-u', '-t']);
const TAG_MUTATING_SHORT_FLAGS = new Set(['-a', '-s', '-u', '-f', '-d', '-m', '-F', '-e']);

/**
 * Pure validator enforcing strict read-only git execution.
 * Returns normalized argv (`[subcommand, ...args]`) or throws GuardrailViolationError.
 */
export function validateGitArgs(subcommand: string, rawArgs: string[] = []): string[] {
  if (typeof subcommand !== 'string' || subcommand.trim().length === 0) {
    throw new GuardrailViolationError('GIT_INVALID_SUBCOMMAND', 'Git subcommand is required.');
  }

  const cmd = subcommand.trim();
  if (cmd.startsWith('-')) {
    throw new GuardrailViolationError(
      'GIT_GLOBAL_FLAG_BLOCKED',
      `Global git flags ("${cmd}") are not allowed.`
    );
  }

  if (!ALLOWED_SET.has(cmd)) {
    throw new GuardrailViolationError(
      'GIT_SUBCOMMAND_BLOCKED',
      `Git subcommand "${cmd}" is blocked by strict read-only guardrails. Allowed: ${ALLOWED_GIT_SUBCOMMANDS.join(', ')}.`
    );
  }

  if (!Array.isArray(rawArgs)) {
    throw new GuardrailViolationError('GIT_INVALID_ARGS', 'Git args must be an array of strings.');
  }

  const args = rawArgs.map((arg) => {
    if (typeof arg !== 'string') {
      throw new GuardrailViolationError('GIT_INVALID_ARGS', 'All git arguments must be strings.');
    }
    if (arg.includes('\0') || arg.includes('\n') || arg.includes('\r')) {
      throw new GuardrailViolationError('GIT_UNSAFE_ARG', 'Git argument contains forbidden control characters.');
    }
    return arg;
  });

  // Check global / universally dangerous flags
  for (const arg of args) {
    if (FORBIDDEN_GLOBAL_OR_DANGEROUS_FLAGS.has(arg)) {
      throw new GuardrailViolationError(
        'GIT_FLAG_BLOCKED',
        `Git flag "${arg}" is blocked by read-only guardrails.`
      );
    }
    for (const prefix of FORBIDDEN_FLAG_PREFIXES) {
      if (prefix === '-c') {
        if (arg === '-c' || (arg.startsWith('-c') && arg.includes('='))) {
          throw new GuardrailViolationError(
            'GIT_FLAG_BLOCKED',
            `Git config override flag "${arg}" is blocked by read-only guardrails.`
          );
        }
      } else if (arg.startsWith(prefix)) {
        throw new GuardrailViolationError(
          'GIT_FLAG_BLOCKED',
          `Git flag "${arg}" is blocked by read-only guardrails.`
        );
      }
    }
  }

  // Subcommand-specific hardening to prevent implicit mutations (e.g. `git branch foo`, `git tag v1`)
  if (cmd === 'branch') {
    let hasListFlag = false;
    let hasShowCurrent = false;
    let expectFilterArg = false;

    for (const arg of args) {
      if (BRANCH_MUTATING_SHORT_FLAGS.has(arg)) {
        throw new GuardrailViolationError(
          'GIT_MUTATING_FLAG',
          `Flag "${arg}" is not allowed with "git branch" in read-only mode.`
        );
      }
      if (arg === '--list' || arg === '-l') {
        hasListFlag = true;
        continue;
      }
      if (arg === '--show-current') {
        hasShowCurrent = true;
        continue;
      }
      if (arg === '--contains' || arg === '--merged' || arg === '--no-merged' || arg === '--points-at') {
        expectFilterArg = true;
        continue;
      }
      if (arg.startsWith('-')) {
        continue;
      }
      if (expectFilterArg) {
        expectFilterArg = false;
        continue;
      }
      if (!hasListFlag) {
        throw new GuardrailViolationError(
          'GIT_BRANCH_MUTATION_BLOCKED',
          `Positional argument "${arg}" with "git branch" requires "--list" to prevent branch creation.`
        );
      }
    }

    if (args.length === 0) {
      return ['branch', '--list'];
    }
    if (!hasListFlag && !hasShowCurrent) {
      return ['branch', '--list', ...args];
    }
    return ['branch', ...args];
  }

  if (cmd === 'tag') {
    let hasListFlag = false;
    let expectFilterArg = false;

    for (const arg of args) {
      if (TAG_MUTATING_SHORT_FLAGS.has(arg)) {
        throw new GuardrailViolationError(
          'GIT_MUTATING_FLAG',
          `Flag "${arg}" is not allowed with "git tag" in read-only mode.`
        );
      }
      if (arg === '--list' || arg === '-l') {
        hasListFlag = true;
        continue;
      }
      if (arg === '-n' || arg === '--contains' || arg === '--merged' || arg === '--no-merged' || arg === '--points-at') {
        expectFilterArg = true;
        continue;
      }
      if (arg.startsWith('-')) {
        continue;
      }
      if (expectFilterArg) {
        expectFilterArg = false;
        continue;
      }
      if (!hasListFlag) {
        throw new GuardrailViolationError(
          'GIT_TAG_MUTATION_BLOCKED',
          `Positional argument "${arg}" with "git tag" requires "--list" to prevent tag creation.`
        );
      }
    }

    if (args.length === 0) {
      return ['tag', '--list'];
    }
    if (!hasListFlag) {
      return ['tag', '--list', ...args];
    }
    return ['tag', ...args];
  }

  if (cmd === 'status') {
    // Disallow flags that could touch or write state; keep status strictly read-only
    for (const arg of args) {
      if (arg.startsWith('--ignored') || arg.startsWith('--untracked-files') || arg === '--short' || arg === '-s' || arg === '-b' || arg === '--branch' || arg === '--porcelain' || arg.startsWith('--porcelain=')) {
        continue;
      }
      if (arg.startsWith('-')) {
        throw new GuardrailViolationError(
          'GIT_STATUS_FLAG_BLOCKED',
          `Unsupported flag "${arg}" for read-only "git status".`
        );
      }
    }
  }

  return [cmd, ...args];
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  command: string;
}

export async function runReadOnlyGit(
  repoRoot: string,
  subcommand: string,
  args: string[] = [],
  options?: { timeoutMs?: number; maxBuffer?: number }
): Promise<GitCommandResult> {
  const canonicalRoot = await validateRepoRoot(repoRoot);
  const safeArgs = validateGitArgs(subcommand, args);

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };

  const { stdout, stderr } = await execFileAsync('git', safeArgs, {
    cwd: canonicalRoot,
    shell: false,
    timeout: options?.timeoutMs ?? 10_000,
    maxBuffer: options?.maxBuffer ?? 1024 * 1024,
    env,
  });

  return {
    stdout,
    stderr,
    command: `git ${safeArgs.join(' ')}`,
  };
}
