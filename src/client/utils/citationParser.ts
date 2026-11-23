import type { CodePeekTarget, ToolActivity } from '../../shared/types';

export interface ParseCitationOptions {
  knownFiles?: string[];
  knownSymbols?: string[];
}

const KNOWN_CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.rb',
  '.php',
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.cs',
  '.swift',
  '.m',
  '.mm',
  '.sql',
  '.graphql',
  '.gql',
  '.proto',
  '.prisma',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.htm',
  '.vue',
  '.svelte',
  '.astro',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.dockerfile',
  '.tf',
  '.hcl',
  '.xml',
  '.svg',
  '.lock',
  '.example',
  '.sample',
  '.template',
]);

const KNOWN_SPECIAL_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'procfile',
  'gemfile',
  'rakefile',
  'cargo.lock',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'license',
  'readme',
  'changelog',
  '.gitignore',
  '.dockerignore',
  '.env.example',
  '.env.sample',
  '.env.template',
  '.prettierrc',
  '.eslintrc',
  '.editorconfig',
  'tsconfig.json',
  'tsconfig.server.json',
  'vite.config.ts',
  'vitest.config.ts',
  'package.json',
]);

/**
 * Common English or novelty hex words that should not be treated as git commit SHAs.
 */
const EXCLUDED_HEX_WORDS = new Set([
  'deadbeef',
  'cafebabe',
  'feedface',
  'deadc0de',
  'baadf00d',
  '0badf00d',
  'defaced',
  'effaced',
  'acceded',
  'decided',
  'facade',
  'feedback',
  'scaffold',
]);

/**
 * Common code member access patterns like `res.json` or `c.html` that look like bare filenames
 * but are actually method/property references in inline code.
 */
const CODE_RECEIVER_PREFIXES = new Set([
  'res',
  'req',
  'response',
  'request',
  'c',
  'ctx',
  'app',
  'router',
  'window',
  'document',
  'console',
  'process',
  'math',
  'json',
  'object',
  'array',
  'promise',
]);

function computeReadingWindow(
  highlightStart: number,
  highlightEnd: number
): {
  startLine: number;
  endLine: number;
  highlightStart: number;
  highlightEnd: number;
} {
  const start = Math.max(1, Math.min(highlightStart, highlightEnd));
  const end = Math.max(start, highlightEnd);
  return {
    startLine: Math.max(1, start - 12),
    endLine: end + 25,
    highlightStart: start,
    highlightEnd: end,
  };
}

interface ExtractedPathAndRange {
  rawPath: string;
  highlightStart?: number;
  highlightEnd?: number;
  symbol?: string;
}

function extractLineRangeSuffix(token: string): ExtractedPathAndRange | null {
  let working = token.trim();
  if (!working) return null;

  // 1. Parenthetical line suffix: `src/foo/bar.ts (L10-25)`, `src/foo/bar.ts (L10-L25)`, `src/foo/bar.ts (lines 10-25)`, `src/foo/bar.ts (L10+)`
  const parenMatch = working.match(
    /^(\S+?)\s+\((?:L|lines?\s*)(\d+)(?:\s*[-–]\s*L?(\d+)|\+)?\)$/i
  );
  if (parenMatch) {
    const rawPath = parenMatch[1];
    const start = Number.parseInt(parenMatch[2], 10);
    const end = parenMatch[3] ? Number.parseInt(parenMatch[3], 10) : start;
    if (Number.isFinite(start) && start >= 1) {
      return {
        rawPath,
        highlightStart: start,
        highlightEnd: Number.isFinite(end) && end >= start ? end : start,
      };
    }
  }

  // Reject any remaining tokens that contain whitespace
  if (/\s/.test(working)) {
    return null;
  }

  // 2. Hash anchor suffix: `src/foo/bar.tsx#L15-L40`, `src/foo/bar.tsx#L15`, `src/foo/bar.tsx#validateRepoRoot`
  const hashIndex = working.indexOf('#');
  if (hashIndex > 0) {
    const rawPath = working.slice(0, hashIndex);
    const fragment = working.slice(hashIndex + 1);
    const lineHashMatch = fragment.match(/^L?(\d+)(?:[-–]L?(\d+))?$/i);
    if (lineHashMatch) {
      const start = Number.parseInt(lineHashMatch[1], 10);
      const end = lineHashMatch[2] ? Number.parseInt(lineHashMatch[2], 10) : start;
      if (Number.isFinite(start) && start >= 1) {
        return {
          rawPath,
          highlightStart: start,
          highlightEnd: Number.isFinite(end) && end >= start ? end : start,
        };
      }
    }
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fragment)) {
      return {
        rawPath,
        symbol: fragment,
      };
    }
    return null;
  }

  // 3. Colon line suffix: `pathGuard.ts:42-88`, `pathGuard.ts:42`, `pathGuard.ts:L42-L88`, `pathGuard.ts:42:10`
  const colonMatch = working.match(/^(.+?):L?(\d+)(?:[-–]L?(\d+)|:(\d+)|\+)?$/i);
  if (colonMatch) {
    const rawPath = colonMatch[1];
    const start = Number.parseInt(colonMatch[2], 10);
    const end = colonMatch[3] ? Number.parseInt(colonMatch[3], 10) : start;
    if (Number.isFinite(start) && start >= 1) {
      return {
        rawPath,
        highlightStart: start,
        highlightEnd: Number.isFinite(end) && end >= start ? end : start,
      };
    }
  }

  return { rawPath: working };
}

function hasRecognizedExtensionOrName(candidatePath: string): boolean {
  const segments = candidatePath.split('/').filter(Boolean);
  const basename = (segments[segments.length - 1] ?? '').toLowerCase();
  if (!basename) return false;

  if (KNOWN_SPECIAL_FILENAMES.has(basename)) {
    return true;
  }

  // Check multi-dot suffixes like `.env.example`
  if (basename.startsWith('.env.')) {
    return true;
  }

  const lastDot = basename.lastIndexOf('.');
  if (lastDot <= 0) {
    return false;
  }

  const stem = basename.slice(0, lastDot);
  const ext = basename.slice(lastDot);

  if (!KNOWN_CODE_EXTENSIONS.has(ext)) {
    return false;
  }

  // If there's no directory separator, guard against `res.json` or `c.html`
  if (segments.length === 1) {
    if (CODE_RECEIVER_PREFIXES.has(stem)) {
      return false;
    }
    if (stem.length <= 1) {
      return false;
    }
  }

  return true;
}

function resolveAgainstKnownFiles(
  candidatePath: string,
  knownFiles?: string[]
): string | null {
  if (!knownFiles || knownFiles.length === 0) return null;

  const normalized = candidatePath.replace(/^\.\//, '').replace(/^\/+/, '');
  if (!normalized) return null;

  // 1. Exact match
  for (const file of knownFiles) {
    if (file === normalized || file === candidatePath) {
      return file;
    }
  }

  // 2. Case-insensitive exact match
  const lower = normalized.toLowerCase();
  for (const file of knownFiles) {
    if (file.toLowerCase() === lower) {
      return file;
    }
  }

  // 3. Unique path suffix or basename match
  const matches = knownFiles.filter((file) => {
    const fileLower = file.toLowerCase();
    return fileLower === lower || fileLower.endsWith(`/${lower}`);
  });

  if (matches.length === 1) {
    return matches[0];
  }

  return null;
}

function isValidPathCharacters(candidatePath: string): boolean {
  if (!candidatePath || candidatePath.length > 200) return false;
  if (
    candidatePath.includes('..') ||
    candidatePath.includes('\\') ||
    candidatePath.includes('//')
  ) {
    return false;
  }
  const segments = candidatePath.split('/');
  for (const seg of segments) {
    if (!seg || !/^[A-Za-z0-9._-]+$/.test(seg)) {
      return false;
    }
  }
  return true;
}

function isGitCommitSha(token: string): boolean {
  if (!/^[0-9a-f]{7,12}$/i.test(token)) {
    return false;
  }
  const lower = token.toLowerCase();
  if (EXCLUDED_HEX_WORDS.has(lower)) {
    return false;
  }
  // Exclude pure numbers and pure letters so natural words or numbers aren't misidentified
  const hasDigit = /[0-9]/.test(lower);
  const hasHexLetter = /[a-f]/.test(lower);
  return hasDigit && hasHexLetter;
}

/**
 * Parses an inline code token into a clickable `CodePeekTarget` (either a repository file with optional
 * line window or a git commit SHA), or returns `null` if the token is ordinary inline code.
 */
export function parseCodeCitation(
  rawToken: string,
  options?: ParseCitationOptions
): CodePeekTarget | null {
  if (typeof rawToken !== 'string') return null;

  const trimmed = rawToken
    .trim()
    .replace(/^`+|`+$/g, '')
    .trim();

  if (!trimmed || trimmed.length > 220 || trimmed.includes('\n')) {
    return null;
  }

  // Exclude URLs and protocol schemes
  if (/^(?:https?|mailto|wss?|ftp|file):\/\//i.test(trimmed)) {
    return null;
  }

  // Check if token is a git commit SHA (7-12 hex chars)
  if (isGitCommitSha(trimmed)) {
    return {
      kind: 'git',
      commitSha: trimmed,
      gitSubcommand: 'show',
    };
  }

  const extracted = extractLineRangeSuffix(trimmed);
  if (!extracted) {
    return null;
  }

  const rawCandidate = extracted.rawPath.trim();
  if (!rawCandidate) {
    return null;
  }

  // Check against knownFiles first (handles exact, suffix, or unique basename matches)
  const knownMatch = resolveAgainstKnownFiles(rawCandidate, options?.knownFiles);
  if (knownMatch) {
    const result: CodePeekTarget = {
      kind: 'file',
      path: knownMatch,
    };
    if (extracted.highlightStart !== undefined && extracted.highlightEnd !== undefined) {
      Object.assign(
        result,
        computeReadingWindow(extracted.highlightStart, extracted.highlightEnd)
      );
    }
    if (extracted.symbol) {
      result.symbol = extracted.symbol;
    }
    return result;
  }

  // Exclude npm scoped packages like `@ai-sdk/openai` unless matched in knownFiles above
  if (rawCandidate.startsWith('@')) {
    return null;
  }

  // Exclude absolute paths / API route paths starting with `/` unless matched in knownFiles above
  if (rawCandidate.startsWith('/')) {
    return null;
  }

  const normalizedPath = rawCandidate.replace(/^\.\//, '');
  if (!isValidPathCharacters(normalizedPath)) {
    return null;
  }

  if (!hasRecognizedExtensionOrName(normalizedPath)) {
    return null;
  }

  const target: CodePeekTarget = {
    kind: 'file',
    path: normalizedPath,
  };

  if (extracted.highlightStart !== undefined && extracted.highlightEnd !== undefined) {
    Object.assign(
      target,
      computeReadingWindow(extracted.highlightStart, extracted.highlightEnd)
    );
  }

  if (extracted.symbol) {
    target.symbol = extracted.symbol;
  }

  return target;
}

/**
 * Converts a `ToolActivity` item (`read_file`, `list_tree`, `grep_search`, `git_inspect`, `query_knowledge_map`)
 * into a `CodePeekTarget` when applicable.
 */
export function parseToolActivityTarget(
  activity: ToolActivity,
  options?: ParseCitationOptions
): CodePeekTarget | null {
  if (!activity || typeof activity !== 'object') return null;

  const { toolName, summary = '', target = '' } = activity;

  if (toolName === 'read_file') {
    // Summary pattern from agentTools: `Read src/foo.ts (L10-50)` or `Read src/foo.ts (L10+)` or `Read src/foo.ts`
    const summaryMatch = summary.match(
      /^Read\s+(.+?)(?:\s+\(L(\d+)(?:-L?(\d+)|\+)?\))?$/i
    );
    if (summaryMatch) {
      const pathFromSummary = summaryMatch[1].trim();
      const resolvedPath =
        resolveAgainstKnownFiles(target || pathFromSummary, options?.knownFiles) ||
        (target || pathFromSummary).replace(/^\.\//, '');

      if (summaryMatch[2]) {
        const highlightStart = Number.parseInt(summaryMatch[2], 10);
        const highlightEnd = summaryMatch[3]
          ? Number.parseInt(summaryMatch[3], 10)
          : highlightStart;
        const window = computeReadingWindow(highlightStart, highlightEnd);
        return {
          kind: 'file',
          path: resolvedPath,
          startLine: window.startLine,
          endLine: window.endLine,
          highlightStart: window.highlightStart,
          highlightEnd: window.highlightEnd,
        };
      }

      return {
        kind: 'file',
        path: resolvedPath,
      };
    }

    if (target) {
      return (
        parseCodeCitation(target, options) ?? {
          kind: 'file',
          path: target.replace(/^\.\//, ''),
        }
      );
    }

    return null;
  }

  if (toolName === 'git_inspect') {
    const combined = `${target} ${summary}`.trim();
    const tokens = combined
      .split(/[\s,()"']+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const detectedSubcommand: 'show' | 'blame' | 'log' = /\bblame\b/i.test(combined)
      ? 'blame'
      : /\bshow\b/i.test(combined)
        ? 'show'
        : 'log';

    for (const tok of tokens) {
      if (isGitCommitSha(tok)) {
        const gitTarget: CodePeekTarget & { target?: string } = {
          kind: 'git',
          commitSha: tok,
          gitSubcommand: 'show',
          target: tok,
        };
        return gitTarget;
      }
    }

    for (const tok of tokens) {
      if (tok === 'git' || tok === 'log' || tok === 'show' || tok === 'blame' || tok.startsWith('-')) {
        continue;
      }
      const parsedFile = parseCodeCitation(tok, options);
      if (parsedFile && parsedFile.kind === 'file' && parsedFile.path) {
        const gitFileTarget: CodePeekTarget & { target?: string } = {
          kind: 'git',
          path: parsedFile.path,
          commitSha: parsedFile.path,
          gitSubcommand: detectedSubcommand === 'blame' ? 'blame' : 'log',
          target: parsedFile.path,
        };
        return gitFileTarget;
      }
    }

    const defaultGitTarget: CodePeekTarget & { target?: string } = {
      kind: 'git',
      gitSubcommand: 'log',
      commitSha: 'HEAD',
      target: 'HEAD',
    };
    return defaultGitTarget;
  }

  if (toolName === 'grep_search' || toolName === 'list_tree' || toolName === 'query_knowledge_map') {
    if (target && target !== '.') {
      const parsed = parseCodeCitation(target, options);
      if (parsed) return parsed;
    }
    const inMatch = summary.match(/\bin\s+(\S+)$/i);
    if (inMatch && inMatch[1] !== '.') {
      const parsed = parseCodeCitation(inMatch[1], options);
      if (parsed) return parsed;
    }
    return null;
  }

  return null;
}
