import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grepSearch, listTree, readFileSlice } from '../src/server/tools/fsTools.js';
import { gitInspect } from '../src/server/tools/gitTools.js';

const execFileAsync = promisify(execFile);

describe('fsTools + gitTools (read-only integration & zero-mutation invariant)', () => {
  let repoDir: string;
  let initialHead: string;

  beforeAll(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scavenger-fixture-repo-'));

    const git = (args: string[]) => execFileAsync('git', args, { cwd: repoDir });
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'architect@example.com']);
    await git(['config', 'user.name', 'Senior Architect']);

    await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'README.md'),
      '# Billing Engine\n\nComputes subscription invoices deterministically.\n'
    );
    await fs.writeFile(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ name: 'billing-engine', version: '1.0.0', dependencies: { hono: '^4.0.0' } }, null, 2)
    );
    await fs.writeFile(
      path.join(repoDir, 'src', 'invoice.ts'),
      [
        'export interface LineItem { cents: number; qty: number; }',
        'export function calculateTotal(items: LineItem[]): number {',
        '  return items.reduce((sum, item) => sum + item.cents * item.qty, 0);',
        '}',
      ].join('\n') + '\n'
    );

    await git(['add', '.']);
    await git(['commit', '-m', 'feat: initial billing engine']);

    await fs.appendFile(
      path.join(repoDir, 'src', 'invoice.ts'),
      'export const CURRENCY = "USD";\n'
    );
    await git(['add', 'src/invoice.ts']);
    await git(['commit', '-m', 'feat: add default USD currency']);

    const headOut = await git(['rev-parse', 'HEAD']);
    initialHead = headOut.stdout.trim();
  });

  afterAll(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it('inspects files, searches symbols, and reads git history without mutating the repository', async () => {
    const tree = await listTree(repoDir, { maxDepth: 3 });
    expect(tree.entries.some((e) => e.path === 'src/invoice.ts')).toBe(true);
    expect(tree.entries.some((e) => e.name === '.git')).toBe(false);

    const file = await readFileSlice(repoDir, { path: 'src/invoice.ts', startLine: 1, endLine: 10 });
    expect(file.isBinary).toBe(false);
    expect(file.content).toContain('calculateTotal');
    expect(file.content).toContain('CURRENCY');

    const grep = await grepSearch(repoDir, { query: 'calculateTotal' });
    expect(grep.matches.length).toBe(1);
    expect(grep.matches[0].path).toBe('src/invoice.ts');
    expect(grep.matches[0].line).toBe(2);

    const logRes = await gitInspect(repoDir, { subcommand: 'log', args: ['--oneline', '-n', '5'] });
    expect(logRes.isGitRepo).toBe(true);
    expect(logRes.output).toContain('feat: add default USD currency');
    expect(logRes.output).toContain('feat: initial billing engine');
    expect(logRes.observedCommits.length).toBeGreaterThanOrEqual(2);

    const statusRes = await gitInspect(repoDir, { subcommand: 'status', args: ['--porcelain'] });
    expect(statusRes.output).toBe('(no output)');

    const blameRes = await gitInspect(repoDir, { subcommand: 'blame', args: ['src/invoice.ts'] });
    expect(blameRes.output).toContain('Senior Architect');

    // Verify strict zero-mutation invariant after all inspection calls
    const postHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
    const postStatus = (await execFileAsync('git', ['status', '--porcelain'], { cwd: repoDir })).stdout.trim();
    expect(postHead).toBe(initialHead);
    expect(postStatus).toBe('');

    // Verify no lockfile left behind
    const gitFiles = await fs.readdir(path.join(repoDir, '.git'));
    expect(gitFiles).not.toContain('index.lock');
  });
});
