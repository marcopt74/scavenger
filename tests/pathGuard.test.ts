import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GuardrailViolationError,
  resolveSafeRepoPath,
  validateRepoRoot,
} from '../src/server/guardrails/pathGuard.js';

describe('pathGuard (strict read-only filesystem confinement)', () => {
  let tempBase: string;
  let repoRoot: string;
  let outsideFile: string;

  beforeAll(async () => {
    tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-pathguard-'));
    repoRoot = path.join(tempBase, 'target-repo');
    outsideFile = path.join(tempBase, 'secret.txt');

    await fs.mkdir(path.join(repoRoot, 'src', 'nested'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'README.md'), '# Sample Repo\n');
    await fs.writeFile(path.join(repoRoot, 'src', 'nested', 'index.ts'), 'export const x = 1;\n');
    await fs.writeFile(path.join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(outsideFile, 'TOP_SECRET_OUTSIDE_REPO\n');

    // Create a symlink inside the repo that attempts to escape outside the repo boundary
    await fs.symlink(outsideFile, path.join(repoRoot, 'escape-link.txt'));
    // Create a legitimate internal symlink
    await fs.symlink(path.join(repoRoot, 'README.md'), path.join(repoRoot, 'readme-link.md'));
  });

  afterAll(async () => {
    await fs.rm(tempBase, { recursive: true, force: true });
  });

  it('validates existing repository root and returns canonical realpath', async () => {
    const canonical = await validateRepoRoot(repoRoot);
    expect(canonical).toBe(await fs.realpath(repoRoot));
  });

  it('rejects non-existent or file paths as repository root', async () => {
    await expect(validateRepoRoot(path.join(tempBase, 'does-not-exist'))).rejects.toThrow(
      GuardrailViolationError
    );
    await expect(validateRepoRoot(outsideFile)).rejects.toThrow(GuardrailViolationError);
  });

  it('permits legitimate nested files and internal symlinks inside the repo', async () => {
    const nested = await resolveSafeRepoPath(repoRoot, 'src/nested/index.ts');
    expect(nested.relativePath).toBe(path.join('src', 'nested', 'index.ts'));

    const internalLink = await resolveSafeRepoPath(repoRoot, 'readme-link.md');
    expect(internalLink.relativePath).toBe('README.md');
  });

  it('blocks parent directory traversal (../) outside repo root', async () => {
    await expect(resolveSafeRepoPath(repoRoot, '../secret.txt')).rejects.toThrow(
      GuardrailViolationError
    );
    await expect(resolveSafeRepoPath(repoRoot, 'src/../../secret.txt')).rejects.toThrow(
      GuardrailViolationError
    );
  });

  it('blocks absolute paths outside repo root', async () => {
    await expect(resolveSafeRepoPath(repoRoot, outsideFile)).rejects.toThrow(GuardrailViolationError);
    await expect(resolveSafeRepoPath(repoRoot, '/etc/hosts')).rejects.toThrow(GuardrailViolationError);
  });

  it('blocks symlinks inside repo that point outside repo root', async () => {
    await expect(resolveSafeRepoPath(repoRoot, 'escape-link.txt')).rejects.toMatchObject({
      name: 'GuardrailViolationError',
      code: 'SYMLINK_ESCAPE',
    });
  });

  it('blocks null bytes and direct .git internal reads', async () => {
    await expect(resolveSafeRepoPath(repoRoot, 'README.md\0.txt')).rejects.toMatchObject({
      code: 'NULL_BYTE_PATH',
    });
    await expect(resolveSafeRepoPath(repoRoot, '.git/HEAD')).rejects.toMatchObject({
      code: 'DOT_GIT_BLOCKED',
    });
  });
});
