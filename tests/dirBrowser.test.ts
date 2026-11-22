import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DirectoryBrowseResponse } from '../src/shared/types.js';
import { createApp } from '../src/server/index.js';
import {
  DirectoryBrowseError,
  browseDirectory,
  buildBreadcrumbs,
} from '../src/server/tools/dirBrowser.js';

describe('dirBrowser & GET /api/fs/browse', () => {
  let tempBase: string;
  let canonicalBase: string;
  let gitRepoDir: string;
  let worktreeDir: string;
  let plainDir: string;
  let hiddenDir: string;
  let sampleFile: string;
  let externalTargetDir: string;

  beforeAll(async () => {
    tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-dirbrowser-'));
    canonicalBase = await fs.realpath(tempBase);

    gitRepoDir = path.join(tempBase, 'alpha-repo');
    worktreeDir = path.join(tempBase, 'beta-worktree');
    plainDir = path.join(tempBase, 'gamma-folder');
    hiddenDir = path.join(tempBase, '.secret-dir');
    sampleFile = path.join(tempBase, 'notes.txt');
    externalTargetDir = path.join(tempBase, 'zeta-target');

    await fs.mkdir(path.join(gitRepoDir, '.git'), { recursive: true });
    await fs.mkdir(worktreeDir, { recursive: true });
    await fs.writeFile(path.join(worktreeDir, '.git'), 'gitdir: ../alpha-repo/.git/worktrees/beta\n');
    await fs.mkdir(path.join(plainDir, 'nested'), { recursive: true });
    await fs.mkdir(hiddenDir, { recursive: true });
    await fs.mkdir(externalTargetDir, { recursive: true });
    await fs.writeFile(sampleFile, 'hello world\n');
    await fs.writeFile(path.join(tempBase, '.hidden-file'), 'hidden\n');

    // Symlink pointing to a valid directory
    await fs.symlink(externalTargetDir, path.join(tempBase, 'delta-link'));
    // Broken symlink should be safely ignored
    await fs.symlink(path.join(tempBase, 'non-existent-target'), path.join(tempBase, 'broken-link'));
  });

  afterAll(async () => {
    await fs.rm(tempBase, { recursive: true, force: true });
  });

  it('lists subdirectories sorted alphabetically, excludes regular files, and detects git repos and worktrees', async () => {
    const res = await browseDirectory({ targetPath: tempBase });

    expect(res.currentPath).toBe(canonicalBase);
    expect(res.parentPath).toBe(path.dirname(canonicalBase));
    expect(res.isCurrentGitRepo).toBe(false);
    expect(res.fileCount).toBe(1); // notes.txt (hidden file excluded by default)
    expect(res.truncated).toBe(false);

    const names = res.entries.map((e) => e.name);
    expect(names).toEqual([
      'alpha-repo',
      'beta-worktree',
      'delta-link',
      'gamma-folder',
      'zeta-target',
    ]);

    const byName = new Map(res.entries.map((e) => [e.name, e]));
    expect(byName.get('alpha-repo')?.isGitRepo).toBe(true);
    expect(byName.get('beta-worktree')?.isGitRepo).toBe(true);
    expect(byName.get('gamma-folder')?.isGitRepo).toBe(false);
    expect(byName.get('delta-link')?.isSymlink).toBe(true);
    expect(byName.has('.secret-dir')).toBe(false);
    expect(byName.has('broken-link')).toBe(false);
  });

  it('reveals hidden directories and counts hidden files when showHidden is true', async () => {
    const res = await browseDirectory({ targetPath: tempBase, showHidden: true });

    const names = res.entries.map((e) => e.name);
    expect(names).toContain('.secret-dir');
    expect(res.entries.find((e) => e.name === '.secret-dir')?.isHidden).toBe(true);
    expect(res.fileCount).toBe(2); // notes.txt + .hidden-file
  });

  it('marks isCurrentGitRepo true when browsing inside a git repository', async () => {
    const res = await browseDirectory({ targetPath: gitRepoDir });
    expect(res.isCurrentGitRepo).toBe(true);
    expect(res.currentPath).toBe(path.join(canonicalBase, 'alpha-repo'));
  });

  it('builds accurate breadcrumbs and handles filesystem root with null parentPath', async () => {
    const root = path.parse(canonicalBase).root;
    const rootRes = await browseDirectory({ targetPath: root });
    expect(rootRes.parentPath).toBeNull();
    expect(rootRes.breadcrumbs).toEqual([{ name: root, path: root }]);

    const crumbs = buildBreadcrumbs(canonicalBase);
    expect(crumbs[0]).toEqual({ name: root, path: root });
    expect(crumbs[crumbs.length - 1]?.path).toBe(canonicalBase);
  });

  it('respects maxEntries truncation cap', async () => {
    const res = await browseDirectory({ targetPath: tempBase, maxEntries: 2 });
    expect(res.entries).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it('falls back to the nearest existing parent directory when fallbackToNearestParent is true', async () => {
    const missingNested = path.join(plainDir, 'does-not-exist', 'deeper');
    const resFromMissing = await browseDirectory({
      targetPath: missingNested,
      fallbackToNearestParent: true,
    });
    expect(resFromMissing.currentPath).toBe(path.join(canonicalBase, 'gamma-folder'));

    const resFromFile = await browseDirectory({
      targetPath: sampleFile,
      fallbackToNearestParent: true,
    });
    expect(resFromFile.currentPath).toBe(canonicalBase);
  });

  it('rejects null bytes, non-existent paths, and file paths when fallback is disabled', async () => {
    await expect(
      browseDirectory({ targetPath: `${tempBase}\0evil`, fallbackToNearestParent: true })
    ).rejects.toMatchObject({
      name: 'DirectoryBrowseError',
      code: 'INVALID_PATH',
      status: 400,
    });

    await expect(
      browseDirectory({ targetPath: path.join(tempBase, 'no-such-dir') })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });

    await expect(browseDirectory({ targetPath: sampleFile })).rejects.toBeInstanceOf(
      DirectoryBrowseError
    );
    await expect(browseDirectory({ targetPath: sampleFile })).rejects.toMatchObject({
      code: 'NOT_DIRECTORY',
      status: 400,
    });
  });

  it('returns existing deduplicated shortcuts', async () => {
    const res = await browseDirectory({ targetPath: tempBase });
    expect(res.shortcuts.length).toBeGreaterThan(0);

    const uniquePaths = new Set(res.shortcuts.map((s) => s.path));
    expect(uniquePaths.size).toBe(res.shortcuts.length);

    for (const shortcut of res.shortcuts) {
      const stat = await fs.stat(shortcut.path);
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it('serves GET /api/fs/browse with proper JSON payload and HTTP error codes', async () => {
    const app = createApp();

    const okRes = await app.request(
      `/api/fs/browse?path=${encodeURIComponent(tempBase)}&showHidden=true`
    );
    expect(okRes.status).toBe(200);
    const okJson = (await okRes.json()) as DirectoryBrowseResponse;
    expect(okJson.currentPath).toBe(canonicalBase);
    expect(okJson.entries.some((e) => e.name === '.secret-dir')).toBe(true);
    expect(okJson.entries.some((e) => e.name === 'alpha-repo' && e.isGitRepo)).toBe(true);

    const notFoundRes = await app.request(
      `/api/fs/browse?path=${encodeURIComponent(path.join(tempBase, 'missing-dir'))}`
    );
    expect(notFoundRes.status).toBe(404);
    const notFoundJson = (await notFoundRes.json()) as { error: string; code: string };
    expect(notFoundJson.code).toBe('NOT_FOUND');

    const fallbackRes = await app.request(
      `/api/fs/browse?path=${encodeURIComponent(path.join(plainDir, 'missing-child'))}&fallback=true`
    );
    expect(fallbackRes.status).toBe(200);
    const fallbackJson = (await fallbackRes.json()) as DirectoryBrowseResponse;
    expect(fallbackJson.currentPath).toBe(path.join(canonicalBase, 'gamma-folder'));

    const fileRes = await app.request(`/api/fs/browse?path=${encodeURIComponent(sampleFile)}`);
    expect(fileRes.status).toBe(400);
    const fileJson = (await fileRes.json()) as { error: string; code: string };
    expect(fileJson.code).toBe('NOT_DIRECTORY');
  });
});
