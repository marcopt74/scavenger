import { describe, expect, it } from 'vitest';
import { validateGitArgs } from '../src/server/guardrails/gitGuard.js';
import { GuardrailViolationError } from '../src/server/guardrails/pathGuard.js';

describe('gitGuard (strict read-only git allowlist)', () => {
  it('allows read-only inspection subcommands and safe flags', () => {
    expect(validateGitArgs('log', ['-n', '10', '--oneline'])).toEqual(['log', '-n', '10', '--oneline']);
    expect(validateGitArgs('show', ['HEAD', '--stat'])).toEqual(['show', 'HEAD', '--stat']);
    expect(validateGitArgs('diff', ['HEAD~1..HEAD'])).toEqual(['diff', 'HEAD~1..HEAD']);
    expect(validateGitArgs('blame', ['-L', '1,20', 'README.md'])).toEqual(['blame', '-L', '1,20', 'README.md']);
    expect(validateGitArgs('shortlog', ['-sn', '--no-merges'])).toEqual(['shortlog', '-sn', '--no-merges']);
    expect(validateGitArgs('status', ['--short', '--branch'])).toEqual(['status', '--short', '--branch']);
    expect(validateGitArgs('rev-parse', ['--is-inside-work-tree'])).toEqual(['rev-parse', '--is-inside-work-tree']);
    expect(validateGitArgs('branch', ['--list'])).toEqual(['branch', '--list']);
    expect(validateGitArgs('branch', ['--show-current'])).toEqual(['branch', '--show-current']);
    expect(validateGitArgs('tag', ['--list', '--sort=-creatordate'])).toEqual([
      'tag',
      '--list',
      '--sort=-creatordate',
    ]);
  });

  it('blocks all mutating git subcommands', () => {
    const forbidden = [
      'checkout',
      'switch',
      'reset',
      'commit',
      'clean',
      'merge',
      'rebase',
      'stash',
      'push',
      'pull',
      'fetch',
      'add',
      'rm',
      'mv',
      'cherry-pick',
      'revert',
      'apply',
      'config',
      'gc',
      'worktree',
      'submodule',
      'init',
      'clone',
    ];

    for (const cmd of forbidden) {
      expect(() => validateGitArgs(cmd, [])).toThrow(GuardrailViolationError);
    }
  });

  it('blocks dangerous global and subcommand flags', () => {
    expect(() => validateGitArgs('-c', ['core.pager=cat', 'log'])).toThrow(GuardrailViolationError);
    expect(() => validateGitArgs('log', ['-c', 'core.fsmonitor=evil'])).toThrow(GuardrailViolationError);
    expect(() => validateGitArgs('log', ['--git-dir=/tmp/other'])).toThrow(GuardrailViolationError);
    expect(() => validateGitArgs('log', ['--work-tree=/tmp'])).toThrow(GuardrailViolationError);
    expect(() => validateGitArgs('diff', ['--output=/tmp/leak.patch'])).toThrow(GuardrailViolationError);
    expect(() => validateGitArgs('diff', ['--ext-diff'])).toThrow(GuardrailViolationError);
  });

  it('blocks branch and tag creation or deletion attempts', () => {
    expect(() => validateGitArgs('branch', ['new-branch'])).toThrow(GuardrailViolationError);
    expect(() => validateGitArgs('branch', ['-D', 'main'])).toThrow(GuardrailViolationError);
    expect(() => validateGitArgs('branch', ['-m', 'old', 'new'])).toThrow(GuardrailViolationError);

    expect(() => validateGitArgs('tag', ['v9.9.9'])).toThrow(GuardrailViolationError);
    expect(() => validateGitArgs('tag', ['-a', 'v1.0.0', '-m', 'release'])).toThrow(GuardrailViolationError);
    expect(() => validateGitArgs('tag', ['-d', 'v1.0.0'])).toThrow(GuardrailViolationError);
  });

  it('blocks control characters and newlines in arguments', () => {
    expect(() => validateGitArgs('log', ['--oneline\n--exec=rm'])).toThrow(GuardrailViolationError);
    expect(() => validateGitArgs('log', ['HEAD\0'])).toThrow(GuardrailViolationError);
  });
});
