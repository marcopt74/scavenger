import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitMilestone, ManifestSnapshot, RootReconSummary } from '../../shared/types.js';
import { validateRepoRoot } from '../guardrails/pathGuard.js';
import { listTree, readFileSlice } from './fsTools.js';
import { gitInspect, isGitRepository } from './gitTools.js';

const README_CANDIDATES = ['README.md', 'readme.md', 'README.mdx', 'README.rst', 'README.txt', 'README'];

const MANIFEST_CANDIDATES: Array<{ filename: string; kind: string; stackHint?: string }> = [
  { filename: 'package.json', kind: 'Node / JS manifest', stackHint: 'Node.js / JavaScript' },
  { filename: 'tsconfig.json', kind: 'TypeScript config', stackHint: 'TypeScript' },
  { filename: 'pnpm-workspace.yaml', kind: 'pnpm workspace', stackHint: 'pnpm monorepo' },
  { filename: 'turbo.json', kind: 'Turborepo config', stackHint: 'Turborepo' },
  { filename: 'nx.json', kind: 'Nx workspace', stackHint: 'Nx' },
  { filename: 'pyproject.toml', kind: 'Python project manifest', stackHint: 'Python' },
  { filename: 'requirements.txt', kind: 'Python requirements', stackHint: 'Python' },
  { filename: 'Cargo.toml', kind: 'Rust Cargo manifest', stackHint: 'Rust' },
  { filename: 'go.mod', kind: 'Go module manifest', stackHint: 'Go' },
  { filename: 'pom.xml', kind: 'Maven manifest', stackHint: 'Java / Maven' },
  { filename: 'build.gradle', kind: 'Gradle build', stackHint: 'JVM / Gradle' },
  { filename: 'build.gradle.kts', kind: 'Gradle Kotlin build', stackHint: 'Kotlin / Gradle' },
  { filename: 'Gemfile', kind: 'Ruby Gemfile', stackHint: 'Ruby' },
  { filename: 'composer.json', kind: 'PHP Composer manifest', stackHint: 'PHP' },
  { filename: 'Makefile', kind: 'Makefile' },
  { filename: 'Dockerfile', kind: 'Dockerfile', stackHint: 'Docker' },
  { filename: 'docker-compose.yml', kind: 'Docker Compose', stackHint: 'Docker Compose' },
  { filename: 'compose.yaml', kind: 'Docker Compose', stackHint: 'Docker Compose' },
];

/**
 * Deterministic Stage 0 root reconnaissance.
 * Strictly read-only: inspects top-level tree, README, root manifests/configs, and recent git milestones.
 */
export async function runRootRecon(rawRepoPath: string): Promise<RootReconSummary> {
  const repoRoot = await validateRepoRoot(rawRepoPath);
  const repoName = path.basename(repoRoot);

  // 1. Top-level directory tree (depth 2 for clean root overview)
  const tree = await listTree(repoRoot, { path: '.', maxDepth: 2, maxEntries: 90 });
  const topLevelEntries = tree.entries
    .filter((entry) => entry.depth === 1)
    .map((entry) => ({ name: entry.name, type: entry.type }));

  const rootDirents = await fs.readdir(repoRoot);
  const rootFileSet = new Set(rootDirents);

  // 2. Root README
  let readmePath: string | undefined;
  let readmeExcerpt: string | undefined;
  for (const candidate of README_CANDIDATES) {
    const match = rootDirents.find((f) => f.toLowerCase() === candidate.toLowerCase());
    if (match) {
      try {
        const read = await readFileSlice(repoRoot, { path: match, startLine: 1, endLine: 80 });
        if (!read.isBinary) {
          readmePath = read.path;
          readmeExcerpt = read.content;
        }
      } catch {
        // Ignore unreadable README
      }
      break;
    }
  }

  // 3. Root manifests & workspace configs
  const manifests: ManifestSnapshot[] = [];
  const stackSet = new Set<string>();

  for (const candidate of MANIFEST_CANDIDATES) {
    if (!rootFileSet.has(candidate.filename)) continue;
    try {
      const read = await readFileSlice(repoRoot, { path: candidate.filename, startLine: 1, endLine: 60 });
      if (!read.isBinary) {
        manifests.push({
          path: read.path,
          kind: candidate.kind,
          excerpt: read.content,
        });
        if (candidate.stackHint) {
          stackSet.add(candidate.stackHint);
        }
        if (candidate.filename === 'package.json') {
          inferJsStack(read.content, stackSet);
        }
      }
    } catch {
      // Ignore unreadable manifest
    }
  }

  // 4. Recent git milestones (if git repo)
  const isGitRepo = await isGitRepository(repoRoot);
  let branch: string | undefined;
  let recentMilestones: GitMilestone[] = [];
  let recentTags: string[] = [];
  let topContributors: string[] = [];

  if (isGitRepo) {
    try {
      const branchRes = await gitInspect(repoRoot, { subcommand: 'branch', args: ['--show-current'] });
      if (branchRes.output && branchRes.output !== '(no output)') {
        branch = branchRes.output.split('\n')[0].trim();
      }
    } catch {
      // Optional
    }

    try {
      const logRes = await gitInspect(repoRoot, {
        subcommand: 'log',
        args: ['-n', '10', '--date=short', '--pretty=format:%H%x09%h%x09%ad%x09%an%x09%s'],
      });
      if (logRes.output && logRes.output !== '(no output)') {
        recentMilestones = logRes.output
          .split('\n')
          .map((line) => line.split('\t'))
          .filter((parts) => parts.length >= 5)
          .map(([hash, shortHash, date, author, ...rest]) => ({
            hash,
            shortHash,
            date,
            author,
            subject: rest.join('\t'),
          }));
      }
    } catch {
      // Empty repo with no commits yet
    }

    try {
      const tagRes = await gitInspect(repoRoot, {
        subcommand: 'tag',
        args: ['--list', '--sort=-creatordate'],
      });
      if (tagRes.output && tagRes.output !== '(no output)') {
        recentTags = tagRes.output
          .split('\n')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 8);
      }
    } catch {
      // Optional
    }

    try {
      const shortlogRes = await gitInspect(repoRoot, {
        subcommand: 'shortlog',
        args: ['-sn', '--no-merges', 'HEAD'],
      });
      if (shortlogRes.output && shortlogRes.output !== '(no output)') {
        topContributors = shortlogRes.output
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 6);
      }
    } catch {
      // Optional
    }
  }

  return {
    repoName,
    repoPath: repoRoot,
    isGitRepo,
    branch,
    topLevelTree: tree.treeText,
    topLevelEntries,
    readmePath,
    readmeExcerpt,
    manifests,
    recentMilestones,
    recentTags,
    topContributors,
    detectedStack: [...stackSet],
    inspectedAt: new Date().toISOString(),
  };
}

function inferJsStack(packageJsonNumbered: string, stackSet: Set<string>): void {
  const lower = packageJsonNumbered.toLowerCase();
  if (lower.includes('"react"')) stackSet.add('React');
  if (lower.includes('"next"')) stackSet.add('Next.js');
  if (lower.includes('"vite"')) stackSet.add('Vite');
  if (lower.includes('"hono"')) stackSet.add('Hono');
  if (lower.includes('"express"')) stackSet.add('Express');
  if (lower.includes('"fastify"')) stackSet.add('Fastify');
  if (lower.includes('"vue"')) stackSet.add('Vue');
  if (lower.includes('"svelte"')) stackSet.add('Svelte');
  if (lower.includes('"vitest"')) stackSet.add('Vitest');
  if (lower.includes('"jest"')) stackSet.add('Jest');
  if (lower.includes('"tailwindcss"')) stackSet.add('Tailwind CSS');
}
