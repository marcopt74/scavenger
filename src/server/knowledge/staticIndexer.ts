import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  RepoCoreFlow,
  RepoDependencyEdge,
  RepoEntryPoint,
  RepoExportedSymbol,
  RepoFileIndexEntry,
  RepoImportRef,
  RepoKnowledgeMap,
  RepoKnowledgeSummary,
  RepoModuleLayer,
  RepoModuleNode,
  RepoSymbolKind,
  RootReconSummary,
} from '../../shared/types.js';
import {
  DEFAULT_IGNORED_DIRS,
  MAX_READ_BYTES,
  isLikelyBinary,
  resolveSafeRepoPath,
  validateRepoRoot,
} from '../guardrails/pathGuard.js';

const MAX_INDEXED_FILES = 1200;

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript (React)',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript (React)',
  '.mjs': 'JavaScript (ESM)',
  '.cjs': 'JavaScript (CJS)',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.c': 'C',
  '.h': 'C/C++ Header',
  '.swift': 'Swift',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.md': 'Markdown',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.html': 'HTML',
  '.sql': 'SQL',
  '.sh': 'Shell',
};

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.swift',
]);

export interface StaticScanProgress {
  phase: 'indexing' | 'dependencies';
  message: string;
  percent: number;
  filesProcessed: number;
  totalFiles: number;
}

export interface GitChangedFile {
  status: 'A' | 'M' | 'D' | 'R';
  path: string;
  oldPath?: string;
}

/**
 * Builds a complete deterministic static knowledge index of a repository.
 * Strictly read-only and confined via pathGuard.
 */
export async function buildStaticKnowledgeMap(
  rawRepoPath: string,
  recon: RootReconSummary,
  options?: {
    headCommit?: string;
    branch?: string;
    maxFiles?: number;
    onProgress?: (progress: StaticScanProgress) => void;
  }
): Promise<RepoKnowledgeMap> {
  const startTime = Date.now();
  const repoRoot = await validateRepoRoot(rawRepoPath);
  const maxFiles = options?.maxFiles ?? MAX_INDEXED_FILES;

  const discoveredPaths = await collectRepoFilePaths(repoRoot, maxFiles);
  const totalFiles = discoveredPaths.length;

  options?.onProgress?.({
    phase: 'indexing',
    message: `Discovered ${totalFiles} repository files to index…`,
    percent: 15,
    filesProcessed: 0,
    totalFiles,
  });

  const rawFiles: RepoFileIndexEntry[] = [];
  for (let i = 0; i < discoveredPaths.length; i++) {
    const relPath = discoveredPaths[i];
    const entry = await indexSingleRepoFile(repoRoot, relPath);
    if (entry) {
      rawFiles.push(entry);
    }

    if (i % 25 === 0 || i === discoveredPaths.length - 1) {
      const ratio = totalFiles > 0 ? (i + 1) / totalFiles : 1;
      options?.onProgress?.({
        phase: 'indexing',
        message: `Indexed ${i + 1} / ${totalFiles} files (${relPath})`,
        percent: Math.round(15 + ratio * 45),
        filesProcessed: i + 1,
        totalFiles,
      });
    }
  }

  options?.onProgress?.({
    phase: 'dependencies',
    message: 'Resolving cross-file imports, module boundaries, and execution flows…',
    percent: 65,
    filesProcessed: rawFiles.length,
    totalFiles,
  });

  const assembled = assembleKnowledgeGraph(repoRoot, recon, rawFiles, {
    totalFiles,
    headCommit: options?.headCommit,
    branch: options?.branch ?? recon.branch,
    scannedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
  });

  return assembled;
}

/**
 * Incrementally updates an existing RepoKnowledgeMap using git diff file changes.
 * Only re-reads added/modified files and preserves existing module synthesis descriptions where applicable.
 */
export async function updateStaticIndexIncrementally(
  rawRepoPath: string,
  existingMap: RepoKnowledgeMap,
  recon: RootReconSummary,
  changedFiles: GitChangedFile[],
  options?: {
    headCommit?: string;
    branch?: string;
    onProgress?: (progress: StaticScanProgress) => void;
  }
): Promise<RepoKnowledgeMap> {
  const startTime = Date.now();
  const repoRoot = await validateRepoRoot(rawRepoPath);

  const fileMap = new Map<string, RepoFileIndexEntry>();
  for (const file of existingMap.files) {
    fileMap.set(file.path, {
      ...file,
      exports: file.exports.map((e) => ({ ...e })),
      imports: file.imports.map((imp) => ({ ...imp, symbols: [...imp.symbols] })),
    });
  }

  const removedPaths = new Set<string>();
  const toReindex: string[] = [];

  for (const change of changedFiles) {
    if (change.oldPath) {
      removedPaths.add(change.oldPath);
      fileMap.delete(change.oldPath);
    }
    if (change.status === 'D') {
      removedPaths.add(change.path);
      fileMap.delete(change.path);
    } else {
      if (!isIgnoredPath(change.path)) {
        toReindex.push(change.path);
      }
    }
  }

  for (let i = 0; i < toReindex.length; i++) {
    const relPath = toReindex[i];
    try {
      const indexed = await indexSingleRepoFile(repoRoot, relPath);
      if (indexed) {
        fileMap.set(relPath, indexed);
      } else {
        fileMap.delete(relPath);
      }
    } catch {
      fileMap.delete(relPath);
    }

    options?.onProgress?.({
      phase: 'indexing',
      message: `Incrementally re-indexed ${i + 1} / ${toReindex.length} changed files (${relPath})`,
      percent: Math.round(25 + ((i + 1) / Math.max(1, toReindex.length)) * 45),
      filesProcessed: i + 1,
      totalFiles: toReindex.length,
    });
  }

  const updatedFiles = [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path));

  // Preserve previously synthesized module roles if module still exists
  const previousModuleRoles = new Map<string, string>();
  for (const mod of existingMap.modules) {
    previousModuleRoles.set(mod.id, mod.role);
  }

  const rebuilt = assembleKnowledgeGraph(repoRoot, recon, updatedFiles, {
    totalFiles: updatedFiles.length,
    headCommit: options?.headCommit ?? existingMap.headCommit,
    branch: options?.branch ?? recon.branch ?? existingMap.branch,
    scannedAt: existingMap.scannedAt,
    updatedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    previousModuleRoles,
    previousSummary: existingMap.summary,
    scanStrategy: existingMap.scanStrategy,
  });

  return rebuilt;
}

function isIgnoredPath(relPath: string): boolean {
  const segments = relPath.split('/');
  for (const seg of segments) {
    if (DEFAULT_IGNORED_DIRS.has(seg)) return true;
  }
  return false;
}

async function collectRepoFilePaths(repoRoot: string, maxFiles: number): Promise<string[]> {
  const collected: string[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    if (collected.length >= maxFiles) return;

    let dirents;
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    const sorted = dirents
      .filter((d) => {
        if (DEFAULT_IGNORED_DIRS.has(d.name)) return false;
        if (d.name.startsWith('.') && d.name !== '.env.example' && d.name !== '.github') {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const dirent of sorted) {
      if (collected.length >= maxFiles) return;
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
        collected.push(childRel);
      }
    }
  }

  await walk(repoRoot, '.');
  return collected;
}

export async function indexSingleRepoFile(
  repoRoot: string,
  relPath: string
): Promise<RepoFileIndexEntry | null> {
  const safe = await resolveSafeRepoPath(repoRoot, relPath);
  const stat = await fs.stat(safe.absolutePath);
  if (!stat.isFile()) return null;

  const ext = path.extname(safe.relativePath).toLowerCase();
  const language = LANGUAGE_BY_EXT[ext] ?? (ext ? ext.slice(1).toUpperCase() : 'Text');
  const moduleId = inferModuleId(safe.relativePath);
  const isEntry = detectIsEntryPoint(safe.relativePath);

  if (stat.size > MAX_READ_BYTES) {
    return {
      path: safe.relativePath,
      moduleId,
      language,
      lines: 0,
      sizeBytes: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      isEntryPoint: isEntry,
      roleSummary: `Large ${language} file (${Math.round(stat.size / 1024)} KB)`,
      exports: [],
      imports: [],
    };
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(safe.absolutePath);
  } catch {
    return null;
  }

  if (isLikelyBinary(buffer)) {
    return null;
  }

  const content = buffer.toString('utf8');
  const lines = content.split(/\r?\n/);
  const exports = CODE_EXTENSIONS.has(ext) ? extractExportedSymbols(lines, ext) : [];
  const imports = CODE_EXTENSIONS.has(ext) ? extractImports(lines, ext) : [];
  const roleSummary = inferFileRoleSummary(safe.relativePath, language, exports, isEntry);

  return {
    path: safe.relativePath,
    moduleId,
    language,
    lines: lines.length,
    sizeBytes: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    roleSummary,
    isEntryPoint: isEntry || undefined,
    exports,
    imports,
  };
}

export function inferModuleId(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length === 1) {
    return 'root';
  }
  if (parts[0] === 'src' && parts.length >= 3) {
    // e.g. src/server/agent/orchestrator.ts -> src/server/agent
    // e.g. src/client/App.tsx -> src/client
    if (parts.length >= 4 && (parts[1] === 'server' || parts[1] === 'client')) {
      return `${parts[0]}/${parts[1]}/${parts[2]}`;
    }
    return `${parts[0]}/${parts[1]}`;
  }
  if ((parts[0] === 'packages' || parts[0] === 'apps' || parts[0] === 'crates' || parts[0] === 'services') && parts.length >= 3) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function inferModuleLayer(moduleId: string, files: RepoFileIndexEntry[]): RepoModuleLayer {
  const lower = moduleId.toLowerCase();
  if (lower.includes('test') || lower.includes('__tests__') || lower.includes('spec')) return 'test';
  if (lower.includes('guard') || lower.includes('security') || lower.includes('auth') || lower.includes('policy')) {
    return 'guard';
  }
  if (lower.includes('route') || lower.includes('api') || lower.includes('controller') || lower.includes('handler')) {
    return 'api';
  }
  if (lower.includes('client') || lower.includes('ui') || lower.includes('component') || lower.includes('view') || lower.includes('page')) {
    return 'ui';
  }
  if (lower.includes('shared') || lower.includes('common') || lower.includes('type') || lower.includes('util')) {
    return 'shared';
  }
  if (lower.includes('store') || lower.includes('session') || lower.includes('db') || lower.includes('model') || lower.includes('knowledge') || lower.includes('data')) {
    return 'data';
  }
  if (lower === 'root' || lower.includes('config')) {
    const hasEntry = files.some((f) => f.isEntryPoint);
    return hasEntry ? 'entry' : 'config';
  }
  if (files.some((f) => f.isEntryPoint)) {
    return 'entry';
  }
  return 'core';
}

function detectIsEntryPoint(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  const base = path.basename(lower);
  if (
    base === 'index.ts' ||
    base === 'index.tsx' ||
    base === 'index.js' ||
    base === 'main.ts' ||
    base === 'main.tsx' ||
    base === 'main.py' ||
    base === 'main.go' ||
    base === 'main.rs' ||
    base === 'app.tsx' ||
    base === 'app.ts' ||
    base === 'server.ts' ||
    base === 'cli.ts'
  ) {
    return true;
  }
  if (lower.startsWith('src/server/routes/') || lower.startsWith('src/routes/')) {
    return true;
  }
  return false;
}

function extractExportedSymbols(lines: string[], ext: string): RepoExportedSymbol[] {
  const symbols: RepoExportedSymbol[] = [];
  const seen = new Set<string>();

  const pushSymbol = (name: string, kind: RepoSymbolKind, line: number) => {
    const clean = name.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    symbols.push({ name: clean, kind, line });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
      const fnMatch = line.match(/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/);
      if (fnMatch) {
        const isComponent = ext.endsWith('x') && /^[A-Z]/.test(fnMatch[1]);
        pushSymbol(fnMatch[1], isComponent ? 'component' : 'function', lineNum);
        continue;
      }

      const classMatch = line.match(/^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/);
      if (classMatch) {
        pushSymbol(classMatch[1], 'class', lineNum);
        continue;
      }

      const ifaceMatch = line.match(/^\s*export\s+(?:interface|type|enum)\s+([A-Za-z0-9_$]+)/);
      if (ifaceMatch) {
        const kind: RepoSymbolKind = line.includes('interface') ? 'interface' : 'type';
        pushSymbol(ifaceMatch[1], kind, lineNum);
        continue;
      }

      const constMatch = line.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/);
      if (constMatch) {
        const isRouter = /Router\b|Route\b/.test(constMatch[1]) || line.includes('new Hono');
        const isComponent = ext.endsWith('x') && /^[A-Z]/.test(constMatch[1]);
        pushSymbol(constMatch[1], isRouter ? 'route' : isComponent ? 'component' : 'const', lineNum);
        continue;
      }
    } else if (ext === '.py') {
      const pyClass = line.match(/^class\s+([A-Za-z0-9_]+)/);
      if (pyClass && !pyClass[1].startsWith('_')) {
        pushSymbol(pyClass[1], 'class', lineNum);
        continue;
      }
      const pyDef = line.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)/);
      if (pyDef && !pyDef[1].startsWith('_')) {
        pushSymbol(pyDef[1], 'function', lineNum);
        continue;
      }
    } else if (ext === '.go') {
      const goFunc = line.match(/^func\s+(?:\([^)]+\)\s+)?([A-Z][A-Za-z0-9_]*)/);
      if (goFunc) {
        pushSymbol(goFunc[1], 'function', lineNum);
        continue;
      }
      const goType = line.match(/^type\s+([A-Z][A-Za-z0-9_]*)\s+(struct|interface)/);
      if (goType) {
        pushSymbol(goType[1], goType[2] === 'interface' ? 'interface' : 'type', lineNum);
        continue;
      }
    } else if (ext === '.rs') {
      const rsFn = line.match(/^\s*pub(?:\([^)]+\))?\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)/);
      if (rsFn) {
        pushSymbol(rsFn[1], 'function', lineNum);
        continue;
      }
      const rsType = line.match(/^\s*pub(?:\([^)]+\))?\s+(struct|enum|trait|type)\s+([A-Za-z0-9_]+)/);
      if (rsType) {
        pushSymbol(rsType[2], rsType[1] === 'trait' ? 'interface' : 'type', lineNum);
        continue;
      }
    }

    if (symbols.length >= 25) break;
  }

  return symbols;
}

function extractImports(lines: string[], ext: string): RepoImportRef[] {
  const imports: RepoImportRef[] = [];
  const bySource = new Map<string, Set<string>>();

  const recordImport = (source: string, symbols: string[]) => {
    const cleanSource = source.trim();
    if (!cleanSource) return;
    let set = bySource.get(cleanSource);
    if (!set) {
      set = new Set<string>();
      bySource.set(cleanSource, set);
    }
    for (const sym of symbols) {
      const trimmed = sym.trim();
      if (trimmed) set.add(trimmed);
    }
  };

  const fullText = lines.slice(0, 180).join('\n');

  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    const importRegex =
      /(?:import|export)\s+(?:type\s+)?(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(fullText)) !== null) {
      const rawClause = match[1] ?? '';
      const source = match[2];
      const parsedSymbols: string[] = [];

      const braceMatch = rawClause.match(/\{([\s\S]*?)\}/);
      if (braceMatch) {
        for (const part of braceMatch[1].split(',')) {
          const cleaned = part
            .replace(/\btype\b/g, '')
            .split(/\s+as\s+/)[0]
            .trim();
          if (cleaned) parsedSymbols.push(cleaned);
        }
      } else if (rawClause.trim()) {
        const def = rawClause.replace(/\*\s+as\s+/, '').trim();
        if (def) parsedSymbols.push(def);
      }

      recordImport(source, parsedSymbols.slice(0, 10));
    }
  } else if (ext === '.py') {
    for (const line of lines.slice(0, 120)) {
      const fromMatch = line.match(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)/);
      if (fromMatch) {
        const syms = fromMatch[2].split(',').map((s) => s.trim());
        recordImport(fromMatch[1], syms);
        continue;
      }
      const impMatch = line.match(/^\s*import\s+([A-Za-z0-9_.]+)/);
      if (impMatch) {
        recordImport(impMatch[1], []);
      }
    }
  }

  for (const [source, symSet] of bySource.entries()) {
    imports.push({
      source,
      symbols: [...symSet].slice(0, 12),
    });
  }

  return imports;
}

export function resolveImportToRepoPath(
  fromFilePath: string,
  importSource: string,
  knownFiles: Set<string>
): string | undefined {
  if (!importSource.startsWith('.')) {
    return undefined;
  }

  const fromDir = path.posix.dirname(fromFilePath);
  const joined = path.posix.normalize(path.posix.join(fromDir, importSource));

  if (knownFiles.has(joined)) {
    return joined;
  }

  // Handle TypeScript ESM imports ending in .js / .jsx -> .ts / .tsx
  if (joined.endsWith('.js')) {
    const base = joined.slice(0, -3);
    if (knownFiles.has(`${base}.ts`)) return `${base}.ts`;
    if (knownFiles.has(`${base}.tsx`)) return `${base}.tsx`;
  }
  if (joined.endsWith('.jsx')) {
    const base = joined.slice(0, -4);
    if (knownFiles.has(`${base}.tsx`)) return `${base}.tsx`;
    if (knownFiles.has(`${base}.ts`)) return `${base}.ts`;
  }

  const candidateExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs'];
  for (const ext of candidateExtensions) {
    if (knownFiles.has(`${joined}${ext}`)) {
      return `${joined}${ext}`;
    }
  }

  for (const ext of candidateExtensions) {
    const indexCandidate = path.posix.join(joined, `index${ext}`);
    if (knownFiles.has(indexCandidate)) {
      return indexCandidate;
    }
  }

  return undefined;
}

function inferFileRoleSummary(
  relPath: string,
  language: string,
  exports: RepoExportedSymbol[],
  isEntry: boolean
): string {
  const base = path.basename(relPath);
  const symbolNames = exports.slice(0, 4).map((e) => e.name);
  const symSuffix = symbolNames.length > 0 ? ` (exports ${symbolNames.join(', ')})` : '';

  if (isEntry) {
    return `Entrypoint module at ${relPath}${symSuffix}`;
  }
  if (relPath.includes('test') || base.includes('.test.') || base.includes('.spec.')) {
    return `Test suite for ${base.replace(/\.(test|spec)\.[^.]+$/, '')}`;
  }
  if (exports.length > 0) {
    return `${language} module defining ${symbolNames.join(', ')}`;
  }
  return `${language} file (${base})`;
}

function assembleKnowledgeGraph(
  repoRoot: string,
  recon: RootReconSummary,
  files: RepoFileIndexEntry[],
  meta: {
    totalFiles: number;
    headCommit?: string;
    branch?: string;
    scannedAt: string;
    updatedAt: string;
    durationMs: number;
    previousModuleRoles?: Map<string, string>;
    previousSummary?: RepoKnowledgeSummary;
    scanStrategy?: 'hybrid' | 'static';
  }
): RepoKnowledgeMap {
  const knownFiles = new Set(files.map((f) => f.path));
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  const dependencyEdges: RepoDependencyEdge[] = [];
  const edgeKeys = new Set<string>();

  for (const file of files) {
    for (const imp of file.imports) {
      const resolved = resolveImportToRepoPath(file.path, imp.source, knownFiles);
      if (resolved) {
        imp.resolvedPath = resolved;
        const key = `${file.path}->${resolved}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          dependencyEdges.push({
            from: file.path,
            to: resolved,
            kind: 'import',
          });
        }
      }
    }
  }

  // Group files into modules
  const moduleFilesMap = new Map<string, RepoFileIndexEntry[]>();
  for (const file of files) {
    let list = moduleFilesMap.get(file.moduleId);
    if (!list) {
      list = [];
      moduleFilesMap.set(file.moduleId, list);
    }
    list.push(file);
  }

  const moduleDeps = new Map<string, Set<string>>();
  const moduleRevDeps = new Map<string, Set<string>>();
  for (const modId of moduleFilesMap.keys()) {
    moduleDeps.set(modId, new Set());
    moduleRevDeps.set(modId, new Set());
  }

  for (const edge of dependencyEdges) {
    const fromFile = fileByPath.get(edge.from);
    const toFile = fileByPath.get(edge.to);
    if (fromFile && toFile && fromFile.moduleId !== toFile.moduleId) {
      moduleDeps.get(fromFile.moduleId)?.add(toFile.moduleId);
      moduleRevDeps.get(toFile.moduleId)?.add(fromFile.moduleId);
    }
  }

  const modules: RepoModuleNode[] = [];
  for (const [modId, modFiles] of moduleFilesMap.entries()) {
    const layer = inferModuleLayer(modId, modFiles);
    const keySymbols: string[] = [];
    for (const f of modFiles) {
      for (const exp of f.exports) {
        if (!keySymbols.includes(exp.name)) {
          keySymbols.push(exp.name);
        }
        if (keySymbols.length >= 12) break;
      }
      if (keySymbols.length >= 12) break;
    }

    const preservedRole = meta.previousModuleRoles?.get(modId);
    const role = preservedRole || buildHeuristicModuleRole(modId, layer, modFiles, keySymbols);

    modules.push({
      id: modId,
      name: modId === 'root' ? `${recon.repoName} (Root)` : modId,
      path: modId === 'root' ? '.' : modId,
      role,
      layer,
      files: modFiles.map((f) => f.path),
      dependsOnModules: [...(moduleDeps.get(modId) ?? [])].sort(),
      dependedOnByModules: [...(moduleRevDeps.get(modId) ?? [])].sort(),
      keySymbols,
    });
  }

  modules.sort((a, b) => a.id.localeCompare(b.id));

  const entryPoints = detectRepoEntryPoints(files);
  const coreFlows = meta.previousSummary?.coreFlows?.length
    ? meta.previousSummary.coreFlows
    : buildHeuristicCoreFlows(recon, modules, entryPoints, dependencyEdges);

  const summary: RepoKnowledgeSummary = meta.previousSummary
    ? {
        ...meta.previousSummary,
        entryPoints,
        coreFlows,
      }
    : {
        purpose: buildHeuristicPurpose(recon),
        architectureOverview: buildHeuristicArchitectureOverview(recon, modules),
        entryPoints,
        coreFlows,
        conventions: buildHeuristicConventions(recon, modules, files),
      };

  const totalSymbols = files.reduce((acc, f) => acc + f.exports.length, 0);

  return {
    version: 1,
    repoPath: repoRoot,
    repoName: recon.repoName,
    headCommit: meta.headCommit,
    branch: meta.branch,
    scannedAt: meta.scannedAt,
    updatedAt: meta.updatedAt,
    scanStrategy: meta.scanStrategy ?? 'static',
    stats: {
      totalFiles: meta.totalFiles,
      indexedFiles: files.length,
      totalModules: modules.length,
      totalSymbols,
      totalEdges: dependencyEdges.length,
      durationMs: meta.durationMs,
    },
    summary,
    modules,
    files,
    dependencyEdges,
  };
}

function buildHeuristicModuleRole(
  modId: string,
  layer: RepoModuleLayer,
  files: RepoFileIndexEntry[],
  keySymbols: string[]
): string {
  const fileNames = files.slice(0, 4).map((f) => path.basename(f.path));
  const symbolHint = keySymbols.length > 0 ? ` — key exports: ${keySymbols.slice(0, 5).join(', ')}` : '';
  return `${capitalizeLayer(layer)} module (${files.length} file${files.length === 1 ? '' : 's'}: ${fileNames.join(', ')}${files.length > 4 ? ', …' : ''})${symbolHint}`;
}

function capitalizeLayer(layer: RepoModuleLayer): string {
  switch (layer) {
    case 'entry':
      return 'Entrypoint & bootstrap';
    case 'api':
      return 'API & routing';
    case 'ui':
      return 'Client UI & presentation';
    case 'guard':
      return 'Security & guardrail';
    case 'data':
      return 'State & persistence';
    case 'shared':
      return 'Shared types & utilities';
    case 'test':
      return 'Verification & test';
    case 'config':
      return 'Workspace configuration';
    default:
      return 'Core domain';
  }
}

function detectRepoEntryPoints(files: RepoFileIndexEntry[]): RepoEntryPoint[] {
  const entries: RepoEntryPoint[] = [];

  for (const file of files) {
    if (!file.isEntryPoint) continue;
    const lower = file.path.toLowerCase();
    let kind: RepoEntryPoint['kind'] = 'library';
    let role = file.roleSummary || `Entry point (${file.path})`;

    if (lower.includes('server') || lower.includes('routes')) {
      kind = 'server';
      role = lower.includes('routes/')
        ? `HTTP/SSE route handler (${path.basename(file.path)})`
        : `Backend server bootstrap (${file.path})`;
    } else if (lower.includes('client') || lower.endsWith('.tsx')) {
      kind = 'client';
      role = `Frontend application entry (${file.path})`;
    } else if (lower.includes('cli')) {
      kind = 'cli';
      role = `CLI entry point (${file.path})`;
    }

    entries.push({
      path: file.path,
      role,
      kind,
    });
  }

  return entries.slice(0, 12);
}

function buildHeuristicPurpose(recon: RootReconSummary): string {
  if (recon.readmeExcerpt) {
    const cleanedLines = recon.readmeExcerpt
      .split('\n')
      .map((l) => l.replace(/^\s*\d+\s*\|\s*/, '').trim())
      .filter((l) => l.length > 20 && !l.startsWith('#') && !l.startsWith('```'));
    if (cleanedLines.length > 0) {
      return cleanedLines.slice(0, 2).join(' ');
    }
  }
  const stack = recon.detectedStack.length > 0 ? recon.detectedStack.join(', ') : 'software';
  return `${recon.repoName} is a ${stack} repository structured across ${recon.topLevelEntries.filter((e) => e.type === 'dir').map((e) => e.name).join(', ') || 'top-level modules'}.`;
}

function buildHeuristicArchitectureOverview(
  recon: RootReconSummary,
  modules: RepoModuleNode[]
): string {
  const nonTestModules = modules.filter((m) => m.layer !== 'test' && m.id !== 'root');
  if (nonTestModules.length === 0) {
    return `${recon.repoName} is organized as a compact root-level codebase (${modules.length} module group).`;
  }
  const modList = nonTestModules
    .slice(0, 6)
    .map((m) => `${m.id} (${m.layer})`)
    .join(', ');
  return `${recon.repoName} separates responsibilities across ${nonTestModules.length} core modules: ${modList}.`;
}

function buildHeuristicCoreFlows(
  recon: RootReconSummary,
  modules: RepoModuleNode[],
  entryPoints: RepoEntryPoint[],
  edges: RepoDependencyEdge[]
): RepoCoreFlow[] {
  const flows: RepoCoreFlow[] = [];
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }

  const primaryEntries = entryPoints.filter((e) => e.kind === 'server' || e.kind === 'client' || e.kind === 'cli');
  const seeds = primaryEntries.length > 0 ? primaryEntries.slice(0, 3) : entryPoints.slice(0, 3);

  for (const seed of seeds) {
    const chain = [seed.path];
    let current = seed.path;
    const visited = new Set<string>([current]);

    for (let depth = 0; depth < 3; depth++) {
      const targets = adj.get(current) ?? [];
      const next = targets.find((t) => !visited.has(t) && !t.includes('types'));
      if (!next) break;
      visited.add(next);
      chain.push(next);
      current = next;
    }

    flows.push({
      id: `flow:${seed.path.replace(/[^a-zA-Z0-9]+/g, '-')}`,
      name: `${path.basename(seed.path, path.extname(seed.path))} Execution Flow`,
      summary: `${seed.role} and its downstream collaborators.`,
      files: chain,
      steps: chain.map((f, idx) => `Step ${idx + 1}: ${f}`),
    });
  }

  if (flows.length === 0 && modules.length > 0) {
    const topMod = modules[0];
    flows.push({
      id: 'flow:main',
      name: `${recon.repoName} Core Execution Path`,
      summary: `Primary module execution across ${topMod.id}.`,
      files: topMod.files.slice(0, 4),
      steps: topMod.files.slice(0, 4).map((f, idx) => `Step ${idx + 1}: ${f}`),
    });
  }

  return flows;
}

function buildHeuristicConventions(
  recon: RootReconSummary,
  modules: RepoModuleNode[],
  files: RepoFileIndexEntry[]
): string[] {
  const conventions: string[] = [];
  if (recon.detectedStack.length > 0) {
    conventions.push(`Primary stack: ${recon.detectedStack.join(', ')}.`);
  }
  const hasTests = modules.some((m) => m.layer === 'test') || files.some((f) => f.path.includes('.test.'));
  if (hasTests) {
    conventions.push('Automated test suites live alongside or under tests/ using *.test.* conventions.');
  }
  const hasGuardrails = modules.some((m) => m.layer === 'guard');
  if (hasGuardrails) {
    conventions.push('Dedicated guardrail modules enforce boundary and safety invariants.');
  }
  return conventions;
}
