import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRootRecon } from '../src/server/tools/rootRecon.js';

const execFileAsync = promisify(execFile);

describe('runRootRecon (Stage 0 root reconnaissance)', () => {
  let gitRepoDir: string;
  let nonGitDir: string;

  beforeAll(async () => {
    gitRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-recon-git-'));
    nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-recon-plain-'));

    await fs.mkdir(path.join(gitRepoDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(gitRepoDir, 'README.md'), '# Telemetry Collector\nCollects metrics.\n');
    await fs.writeFile(
      path.join(gitRepoDir, 'package.json'),
      JSON.stringify({ name: 'telemetry', dependencies: { react: '^19.0.0', vite: '^8.0.0' } }, null, 2)
    );
    await fs.writeFile(path.join(gitRepoDir, 'tsconfig.json'), '{ "compilerOptions": {} }\n');
    await fs.writeFile(path.join(gitRepoDir, 'src', 'main.ts'), 'console.log("hi");\n');

    await execFileAsync('git', ['init', '-b', 'main'], { cwd: gitRepoDir });
    await execFileAsync('git', ['config', 'user.email', 'dev@example.com'], { cwd: gitRepoDir });
    await execFileAsync('git', ['config', 'user.name', 'Dev'], { cwd: gitRepoDir });
    await execFileAsync('git', ['add', '.'], { cwd: gitRepoDir });
    await execFileAsync('git', ['commit', '-m', 'chore: bootstrap telemetry collector'], { cwd: gitRepoDir });

    await fs.writeFile(path.join(nonGitDir, 'pyproject.toml'), '[project]\nname = "plain-py"\n');
  });

  afterAll(async () => {
    await fs.rm(gitRepoDir, { recursive: true, force: true });
    await fs.rm(nonGitDir, { recursive: true, force: true });
  });

  it('captures root README, manifests, stack hints, top-level tree, and recent git milestones', async () => {
    const recon = await runRootRecon(gitRepoDir);

    expect(recon.isGitRepo).toBe(true);
    expect(recon.branch).toBe('main');
    expect(recon.readmePath).toBe('README.md');
    expect(recon.readmeExcerpt).toContain('Telemetry Collector');
    expect(recon.manifests.map((m) => m.path)).toContain('package.json');
    expect(recon.manifests.map((m) => m.path)).toContain('tsconfig.json');
    expect(recon.detectedStack).toContain('TypeScript');
    expect(recon.detectedStack).toContain('React');
    expect(recon.detectedStack).toContain('Vite');
    expect(recon.recentMilestones.length).toBe(1);
    expect(recon.recentMilestones[0].subject).toBe('chore: bootstrap telemetry collector');
  });

  it('handles non-git directories cleanly without failing', async () => {
    const recon = await runRootRecon(nonGitDir);

    expect(recon.isGitRepo).toBe(false);
    expect(recon.recentMilestones).toEqual([]);
    expect(recon.manifests.map((m) => m.path)).toContain('pyproject.toml');
    expect(recon.detectedStack).toContain('Python');
  });
});
