import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_IGNORED_DIRS,
  MAX_READ_BYTES,
  isLikelyBinary,
  resolveSafeRepoPath,
} from '../guardrails/pathGuard.js';

export interface TreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  depth: number;
}

export interface ListTreeResult {
  root: string;
  treeText: string;
  entries: TreeEntry[];
  truncated: boolean;
  totalVisited: number;
}

export async function listTree(
  repoRoot: string,
  options?: {
    path?: string;
    maxDepth?: number;
    maxEntries?: number;
    includeHidden?: boolean;
  }
): Promise<ListTreeResult> {
  const target = await resolveSafeRepoPath(repoRoot, options?.path ?? '.');
  const maxDepth = Math.min(Math.max(options?.maxDepth ?? 3, 1), 6);
  const maxEntries = Math.min(Math.max(options?.maxEntries ?? 160, 10), 400);
  const includeHidden = options?.includeHidden ?? false;

  const stat = await fs.stat(target.absolutePath);
  if (!stat.isDirectory()) {
    return {
      root: target.relativePath,
      treeText: `${target.relativePath} (file)`,
      entries: [{ name: path.basename(target.absolutePath), path: target.relativePath, type: 'file', depth: 0 }],
      truncated: false,
      totalVisited: 1,
    };
  }

  const lines: string[] = [];
  const entries: TreeEntry[] = [];
  let truncated = false;
  let totalVisited = 0;

  async function walk(absDir: string, relDir: string, depth: number, prefix: string): Promise<void> {
    if (depth > maxDepth || truncated) return;

    let dirents;
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    const filtered = dirents
      .filter((d) => {
        if (DEFAULT_IGNORED_DIRS.has(d.name)) return false;
        if (!includeHidden && d.name.startsWith('.') && d.name !== '.env.example' && d.name !== '.github') {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < filtered.length; i++) {
      if (totalVisited >= maxEntries) {
        truncated = true;
        lines.push(`${prefix}... (truncated at ${maxEntries} entries)`);
        return;
      }

      const dirent = filtered[i];
      const isLast = i === filtered.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');
      const childRel = relDir === '.' ? dirent.name : `${relDir}/${dirent.name}`;
      const childAbs = path.join(absDir, dirent.name);

      // Skip symlinks pointing outside the repository boundary
      if (dirent.isSymbolicLink()) {
        try {
          await resolveSafeRepoPath(repoRoot, childRel);
        } catch {
          continue;
        }
      }

      const isDir = dirent.isDirectory();
      totalVisited++;
      entries.push({
        name: dirent.name,
        path: childRel,
        type: isDir ? 'dir' : 'file',
        depth,
      });

      lines.push(`${prefix}${connector}${dirent.name}${isDir ? '/' : ''}`);

      if (isDir && depth < maxDepth) {
        await walk(childAbs, childRel, depth + 1, nextPrefix);
      }
    }
  }

  lines.push(target.relativePath === '.' ? `${path.basename(target.repoRoot)}/` : `${target.relativePath}/`);
  await walk(target.absolutePath, target.relativePath, 1, '');

  return {
    root: target.relativePath,
    treeText: lines.join('\n'),
    entries,
    truncated,
    totalVisited,
  };
}

export interface ReadFileResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  isBinary: boolean;
  content: string;
}

export async function readFileSlice(
  repoRoot: string,
  options: {
    path: string;
    startLine?: number;
    endLine?: number;
  }
): Promise<ReadFileResult> {
  const safe = await resolveSafeRepoPath(repoRoot, options.path);
  const stat = await fs.stat(safe.absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Path "${options.path}" is a directory, not a file. Use list_tree instead.`);
  }

  const fileHandle = await fs.open(safe.absolutePath, 'r');
  let buffer: Buffer;
  let byteTruncated = false;
  try {
    const readSize = Math.min(stat.size, MAX_READ_BYTES);
    byteTruncated = stat.size > MAX_READ_BYTES;
    buffer = Buffer.alloc(readSize);
    if (readSize > 0) {
      await fileHandle.read(buffer, 0, readSize, 0);
    }
  } finally {
    await fileHandle.close();
  }

  if (isLikelyBinary(buffer)) {
    return {
      path: safe.relativePath,
      startLine: 0,
      endLine: 0,
      totalLines: 0,
      truncated: false,
      isBinary: true,
      content: `[Binary file (${stat.size} bytes) — contents omitted]`,
    };
  }

  const text = buffer.toString('utf8');
  const allLines = text.split(/\r?\n/);
  const totalLines = allLines.length;

  const startLine = Math.max(1, options.startLine ?? 1);
  const requestedEnd = options.endLine ?? Math.min(totalLines, startLine + 199);
  const maxWindowEnd = Math.min(totalLines, startLine + 249);
  const endLine = Math.max(startLine, Math.min(requestedEnd, maxWindowEnd));

  const slice = allLines.slice(startLine - 1, endLine);
  const numbered = slice.map((line, idx) => `${String(startLine + idx).padStart(4, ' ')} | ${line}`).join('\n');

  const truncated = byteTruncated || endLine < totalLines;

  return {
    path: safe.relativePath,
    startLine,
    endLine,
    totalLines,
    truncated,
    isBinary: false,
    content: numbered,
  };
}

export interface GrepMatch {
  path: string;
  line: number;
  snippet: string;
}

export interface GrepSearchResult {
  query: string;
  scope: string;
  matches: GrepMatch[];
  truncated: boolean;
  filesSearched: number;
}

export async function grepSearch(
  repoRoot: string,
  options: {
    query: string;
    path?: string;
    isRegex?: boolean;
    caseSensitive?: boolean;
    maxMatches?: number;
  }
): Promise<GrepSearchResult> {
  if (!options.query || options.query.trim().length === 0) {
    throw new Error('Search query must not be empty.');
  }

  const target = await resolveSafeRepoPath(repoRoot, options.path ?? '.');
  const maxMatches = Math.min(Math.max(options.maxMatches ?? 40, 1), 100);
  const flags = options.caseSensitive ? '' : 'i';
  const matcher = options.isRegex
    ? new RegExp(options.query, flags)
    : new RegExp(escapeRegex(options.query), flags);

  const matches: GrepMatch[] = [];
  let truncated = false;
  let filesSearched = 0;
  const maxFilesToScan = 600;

  async function searchFile(absPath: string, relPath: string): Promise<void> {
    if (matches.length >= maxMatches || filesSearched >= maxFilesToScan) {
      truncated = true;
      return;
    }

    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return;

    let buf: Buffer;
    try {
      buf = await fs.readFile(absPath);
    } catch {
      return;
    }
    if (isLikelyBinary(buf)) return;

    filesSearched++;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (matcher.test(lines[i])) {
        matches.push({
          path: relPath,
          line: i + 1,
          snippet: lines[i].trim().slice(0, 180),
        });
        if (matches.length >= maxMatches) {
          truncated = true;
          return;
        }
      }
    }
  }

  async function walk(absDir: string, relDir: string): Promise<void> {
    if (matches.length >= maxMatches || filesSearched >= maxFilesToScan) {
      truncated = true;
      return;
    }

    let dirents;
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (matches.length >= maxMatches || filesSearched >= maxFilesToScan) {
        truncated = true;
        return;
      }
      if (DEFAULT_IGNORED_DIRS.has(dirent.name)) continue;

      const childRel = relDir === '.' ? dirent.name : `${relDir}/${dirent.name}`;
      const childAbs = path.join(absDir, dirent.name);

      if (dirent.isSymbolicLink()) {
        try {
          await resolveSafeRepoPath(repoRoot, childRel);
        } catch {
          continue;
        }
      }

      if (dirent.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (dirent.isFile()) {
        await searchFile(childAbs, childRel);
      }
    }
  }

  const targetStat = await fs.stat(target.absolutePath);
  if (targetStat.isFile()) {
    await searchFile(target.absolutePath, target.relativePath);
  } else {
    await walk(target.absolutePath, target.relativePath);
  }

  return {
    query: options.query,
    scope: target.relativePath,
    matches,
    truncated,
    filesSearched,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
