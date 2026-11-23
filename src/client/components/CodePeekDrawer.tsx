import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode,
  GitBranch,
  GitCommitHorizontal,
  History,
  Loader2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CodePeekFileResponse,
  CodePeekGitResponse,
  CodePeekLine,
  CodePeekTarget,
  RepoExportedSymbol,
  RepoSymbolKind,
} from '../../shared/types';
import { fetchCodePeekFile, fetchCodePeekGit } from '../api/client';

export interface CodePeekDrawerProps {
  sessionId: string;
  target: CodePeekTarget | null;
  disabled?: boolean;
  onClose: () => void;
  onSelectTarget: (target: CodePeekTarget) => void;
  onAskScavenger: (prompt: string) => void;
}

type DrawerTab = 'code' | 'blame' | 'log' | 'show';

const SYMBOL_KIND_SHORT: Record<RepoSymbolKind, string> = {
  function: 'fn',
  class: 'class',
  interface: 'iface',
  type: 'type',
  const: 'const',
  component: 'ui',
  route: 'route',
  default: 'def',
};

function mergeCodeLines(existing: CodePeekLine[], incoming: CodePeekLine[]): CodePeekLine[] {
  const byLine = new Map<number, string>();
  for (const item of existing) {
    byLine.set(item.lineNumber, item.text);
  }
  for (const item of incoming) {
    byLine.set(item.lineNumber, item.text);
  }
  return Array.from(byLine.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([lineNumber, text]) => ({ lineNumber, text }));
}

function classifyDiffLine(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) {
    return 'diff-line diff-meta';
  }
  if (line.startsWith('commit ') || line.startsWith('Author:') || line.startsWith('Date:')) {
    return 'diff-line diff-header';
  }
  if (line.startsWith('@@')) {
    return 'diff-line diff-hunk';
  }
  if (line.startsWith('+')) {
    return 'diff-line diff-add';
  }
  if (line.startsWith('-')) {
    return 'diff-line diff-del';
  }
  return 'diff-line';
}

export function CodePeekDrawer({
  sessionId,
  target,
  disabled = false,
  onClose,
  onSelectTarget,
  onAskScavenger,
}: CodePeekDrawerProps) {
  const [activeTab, setActiveTab] = useState<DrawerTab>('code');
  const [fileData, setFileData] = useState<CodePeekFileResponse | null>(null);
  const [gitData, setGitData] = useState<CodePeekGitResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<'up' | 'down' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlightStart, setHighlightStart] = useState<number | undefined>(undefined);
  const [highlightEnd, setHighlightEnd] = useState<number | undefined>(undefined);
  const [depsExpanded, setDepsExpanded] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);

  const codeViewerRef = useRef<HTMLDivElement>(null);

  const resolvedGitTarget = useMemo(() => {
    if (!target) return 'HEAD';
    const extraTarget = (target as CodePeekTarget & { target?: string }).target;
    return target.commitSha || target.path || extraTarget || 'HEAD';
  }, [target]);

  // Reset tab and highlight state when target changes
  useEffect(() => {
    if (!target) return;
    setError(null);
    setCopied(false);
    setHighlightStart(target.highlightStart);
    setHighlightEnd(target.highlightEnd ?? target.highlightStart);

    if (target.kind === 'git') {
      const sub = target.gitSubcommand ?? (target.commitSha && target.commitSha !== 'HEAD' ? 'show' : 'log');
      setActiveTab(sub);
      setFileData(null);
    } else {
      setActiveTab('code');
      setGitData(null);
    }
  }, [target]);

  // Escape key closes drawer
  useEffect(() => {
    if (!target) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [target, onClose]);

  // Fetch file or git data when target or activeTab changes
  useEffect(() => {
    if (!target || !sessionId) return;

    let cancelled = false;

    const loadData = async () => {
      setLoading(true);
      setError(null);

      try {
        if (activeTab === 'code' && target.path) {
          const data = await fetchCodePeekFile(sessionId, {
            path: target.path,
            startLine: target.startLine,
            endLine: target.endLine,
          });
          if (cancelled) return;
          setFileData(data);

          // If target specified a symbol name without explicit line numbers, locate it in exports
          if (target.symbol && target.highlightStart === undefined) {
            const matchedSym = data.exports.find(
              (exp) => exp.name.toLowerCase() === target.symbol!.toLowerCase()
            );
            if (matchedSym) {
              setHighlightStart(matchedSym.line);
              setHighlightEnd(matchedSym.line);
            }
          }
        } else {
          const subcommand: 'show' | 'blame' | 'log' =
            activeTab === 'blame'
              ? 'blame'
              : activeTab === 'log'
                ? 'log'
                : 'show';

          const gitTargetArg =
            subcommand === 'blame' || subcommand === 'log'
              ? target.path || resolvedGitTarget
              : target.commitSha || resolvedGitTarget;

          const data = await fetchCodePeekGit(sessionId, {
            subcommand,
            target: gitTargetArg,
            startLine: subcommand === 'blame' ? (fileData?.startLine ?? target.startLine) : undefined,
            endLine: subcommand === 'blame' ? (fileData?.endLine ?? target.endLine) : undefined,
          });
          if (cancelled) return;
          setGitData(data);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to inspect repository target.');
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadData();

    return () => {
      cancelled = true;
    };
  }, [sessionId, target, activeTab, resolvedGitTarget]);

  // Scroll highlighted line into view when fileData loads or highlightStart changes
  useEffect(() => {
    if (activeTab !== 'code' || !fileData || !highlightStart || !codeViewerRef.current) {
      return;
    }
    const row = codeViewerRef.current.querySelector<HTMLElement>(
      `[data-line-number="${highlightStart}"]`
    );
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [activeTab, fileData, highlightStart]);

  const handleLoadEarlierLines = useCallback(async () => {
    if (!fileData || fileData.startLine <= 1 || loadingMore) return;
    const newStart = Math.max(1, fileData.startLine - 80);
    const fetchEnd = fileData.startLine - 1;
    setLoadingMore('up');
    try {
      const more = await fetchCodePeekFile(sessionId, {
        path: fileData.path,
        startLine: newStart,
        endLine: fetchEnd,
      });
      const merged = mergeCodeLines(fileData.lines, more.lines);
      setFileData({
        ...fileData,
        startLine: Math.min(fileData.startLine, more.startLine),
        lines: merged,
        content: merged.map((l) => l.text).join('\n'),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load earlier lines.');
    } finally {
      setLoadingMore(null);
    }
  }, [fileData, loadingMore, sessionId]);

  const handleLoadMoreLines = useCallback(async () => {
    if (!fileData || fileData.endLine >= fileData.totalLines || loadingMore) return;
    const fetchStart = fileData.endLine + 1;
    const newEnd = Math.min(fileData.totalLines, fileData.endLine + 80);
    setLoadingMore('down');
    try {
      const more = await fetchCodePeekFile(sessionId, {
        path: fileData.path,
        startLine: fetchStart,
        endLine: newEnd,
      });
      const merged = mergeCodeLines(fileData.lines, more.lines);
      setFileData({
        ...fileData,
        endLine: Math.max(fileData.endLine, more.endLine),
        lines: merged,
        content: merged.map((l) => l.text).join('\n'),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more lines.');
    } finally {
      setLoadingMore(null);
    }
  }, [fileData, loadingMore, sessionId]);

  const handleSelectSymbol = useCallback(
    async (sym: RepoExportedSymbol) => {
      setActiveTab('code');
      setHighlightStart(sym.line);
      setHighlightEnd(sym.line);

      if (fileData && (sym.line < fileData.startLine || sym.line > fileData.endLine)) {
        setLoading(true);
        try {
          const slice = await fetchCodePeekFile(sessionId, {
            path: fileData.path,
            startLine: Math.max(1, sym.line - 12),
            endLine: sym.line + 45,
          });
          setFileData(slice);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to jump to symbol line.');
        } finally {
          setLoading(false);
        }
      }
    },
    [fileData, sessionId]
  );

  const handleClickLineNumber = useCallback(
    (lineNumber: number, shiftKey: boolean) => {
      if (shiftKey && highlightStart !== undefined) {
        const start = Math.min(highlightStart, lineNumber);
        const end = Math.max(highlightStart, lineNumber);
        setHighlightStart(start);
        setHighlightEnd(end);
      } else {
        setHighlightStart(lineNumber);
        setHighlightEnd(lineNumber);
      }
    },
    [highlightStart]
  );

  const handleCopyContent = useCallback(async () => {
    const textToCopy =
      activeTab === 'code'
        ? fileData?.content ?? ''
        : gitData?.output ?? '';
    if (!textToCopy) return;
    try {
      await navigator.clipboard?.writeText(textToCopy);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failures
    }
  }, [activeTab, fileData, gitData]);

  const handleExplainSlice = useCallback(() => {
    if (!target) return;
    if (activeTab === 'code' && (fileData || target.path)) {
      const path = fileData?.path ?? target.path!;
      const start = highlightStart ?? fileData?.startLine ?? target.startLine ?? 1;
      const end = highlightEnd ?? fileData?.endLine ?? target.endLine ?? start;
      const rangeStr = start === end ? `L${start}` : `L${start}-${end}`;
      onAskScavenger(
        `Explain the implementation and responsibilities of \`${path}:${start}-${end}\` (${rangeStr}) and how it fits into the surrounding module.`
      );
    } else {
      const ref = gitData?.target ?? resolvedGitTarget;
      onAskScavenger(
        `Explain the changes and architectural intent of git ${activeTab} on \`${ref}\`.`
      );
    }
  }, [activeTab, fileData, gitData, highlightEnd, highlightStart, onAskScavenger, resolvedGitTarget, target]);

  const handleWhatBreaks = useCallback(() => {
    if (!target) return;
    const path = fileData?.path ?? target.path;
    if (path) {
      const rangeSuffix =
        highlightStart !== undefined
          ? ` (especially around L${highlightStart}${highlightEnd && highlightEnd !== highlightStart ? `-${highlightEnd}` : ''})`
          : '';
      onAskScavenger(
        `What breaks if \`${path}\`${rangeSuffix} changes? Trace its exported contracts, callers, and blast radius across the repository.`
      );
    } else {
      onAskScavenger(
        `Analyze the blast radius and downstream impact of commit \`${resolvedGitTarget}\`.`
      );
    }
  }, [fileData, highlightEnd, highlightStart, onAskScavenger, resolvedGitTarget, target]);

  if (!target) {
    return null;
  }

  const hasFileContext = Boolean(target.path);
  const displayTitle = target.path || (target.commitSha ? `Commit ${target.commitSha}` : resolvedGitTarget);
  const totalDepsCount =
    (fileData?.importsRepoFiles.length ?? 0) + (fileData?.importedByFiles.length ?? 0);

  return (
    <div
      className="code-peek-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <aside
        className="code-peek-drawer"
        onClick={(e) => e.stopPropagation()}
        aria-label="Read-Only Code & Git Peek Inspector"
      >
        {/* Header Bar */}
        <header className="code-peek-header">
          <div className="code-peek-header-top">
            <div className="code-peek-title-wrap">
              {target.kind === 'git' && !target.path ? (
                <GitCommitHorizontal size={16} className="code-peek-title-icon" />
              ) : (
                <FileCode size={16} className="code-peek-title-icon" />
              )}
              <span className="code-peek-path" title={displayTitle}>
                {displayTitle}
              </span>
            </div>

            <div className="code-peek-header-badges">
              {fileData?.moduleId && (
                <span className="code-peek-module-badge">
                  {fileData.moduleId}
                  {fileData.moduleLayer ? ` · ${fileData.moduleLayer}` : ''}
                </span>
              )}
              {fileData && (
                <span className="code-peek-lines-badge">
                  L{fileData.startLine}–{fileData.endLine} of {fileData.totalLines} lines
                </span>
              )}
              <span className="code-peek-readonly-badge" title="Strictly Read-Only Inspector">
                <ShieldCheck size={13} className="readonly-icon" />
                <span>Read-Only</span>
              </span>
              <button
                type="button"
                className="icon-button code-peek-close-btn"
                onClick={onClose}
                aria-label="Close code inspector"
                title="Close (Esc)"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {fileData?.roleSummary && (
            <p className="code-peek-role-summary">{fileData.roleSummary}</p>
          )}

          {/* Mode / View Tabs */}
          <div className="code-peek-tabs" role="tablist">
            {hasFileContext && (
              <>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'code'}
                  className={`code-peek-tab${activeTab === 'code' ? ' is-active' : ''}`}
                  onClick={() => setActiveTab('code')}
                >
                  <FileCode size={13} />
                  <span>Source Code</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'blame'}
                  className={`code-peek-tab${activeTab === 'blame' ? ' is-active' : ''}`}
                  onClick={() => setActiveTab('blame')}
                >
                  <GitBranch size={13} />
                  <span>Git Blame</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'log'}
                  className={`code-peek-tab${activeTab === 'log' ? ' is-active' : ''}`}
                  onClick={() => setActiveTab('log')}
                >
                  <History size={13} />
                  <span>File Commits</span>
                </button>
              </>
            )}

            {(!hasFileContext || target.commitSha) && (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'show'}
                className={`code-peek-tab${activeTab === 'show' ? ' is-active' : ''}`}
                onClick={() => setActiveTab('show')}
              >
                <GitCommitHorizontal size={13} />
                <span>Commit Diff</span>
              </button>
            )}

            {!hasFileContext && (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'log'}
                className={`code-peek-tab${activeTab === 'log' ? ' is-active' : ''}`}
                onClick={() => setActiveTab('log')}
              >
                <History size={13} />
                <span>Recent Commits</span>
              </button>
            )}
          </div>
        </header>

        {/* Exported Symbols Strip */}
        {activeTab === 'code' && fileData && fileData.exports.length > 0 && (
          <div className="code-peek-symbols-strip">
            <span className="code-peek-strip-label">Exports</span>
            <div className="code-peek-pills-row">
              {fileData.exports.map((sym) => {
                const isSelected =
                  highlightStart !== undefined &&
                  highlightEnd !== undefined &&
                  sym.line >= highlightStart &&
                  sym.line <= highlightEnd;
                return (
                  <button
                    key={`${sym.name}:${sym.line}`}
                    type="button"
                    className={`code-peek-symbol-pill${isSelected ? ' is-active' : ''}`}
                    onClick={() => void handleSelectSymbol(sym)}
                    title={`Jump to ${sym.kind} ${sym.name} at line ${sym.line}`}
                  >
                    <span className="code-peek-symbol-kind">
                      {SYMBOL_KIND_SHORT[sym.kind] || sym.kind}
                    </span>
                    <span className="code-peek-symbol-name">{sym.name}</span>
                    <span className="code-peek-symbol-line">:L{sym.line}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Collaborating Files Strip (Dependencies) */}
        {activeTab === 'code' && fileData && totalDepsCount > 0 && (
          <div className="code-peek-deps-strip">
            <button
              type="button"
              className="code-peek-deps-toggle"
              onClick={() => setDepsExpanded((prev) => !prev)}
            >
              {depsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span>
                Imports ({fileData.importsRepoFiles.length}) · Imported by (
                {fileData.importedByFiles.length})
              </span>
            </button>

            {depsExpanded && (
              <div className="code-peek-deps-groups">
                {fileData.importsRepoFiles.length > 0 && (
                  <div className="code-peek-deps-group">
                    <span className="code-peek-strip-label">
                      Imports ({fileData.importsRepoFiles.length})
                    </span>
                    <div className="code-peek-pills-row">
                      {fileData.importsRepoFiles.map((depPath) => (
                        <button
                          key={`imp:${depPath}`}
                          type="button"
                          className="code-peek-dep-pill"
                          onClick={() => onSelectTarget({ kind: 'file', path: depPath })}
                          title={`Inspect ${depPath}`}
                        >
                          <FileCode size={11} />
                          <span>{depPath}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {fileData.importedByFiles.length > 0 && (
                  <div className="code-peek-deps-group">
                    <span className="code-peek-strip-label">
                      Imported by ({fileData.importedByFiles.length})
                    </span>
                    <div className="code-peek-pills-row">
                      {fileData.importedByFiles.map((depPath) => (
                        <button
                          key={`by:${depPath}`}
                          type="button"
                          className="code-peek-dep-pill"
                          onClick={() => onSelectTarget({ kind: 'file', path: depPath })}
                          title={`Inspect ${depPath}`}
                        >
                          <FileCode size={11} />
                          <span>{depPath}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Main Viewer Body */}
        <div ref={codeViewerRef} className="code-peek-body">
          {loading && (
            <div className="code-peek-state">
              <Loader2 size={18} className="spin-icon" />
              <span>Inspecting repository (read-only)…</span>
            </div>
          )}

          {!loading && error && (
            <div className="code-peek-error">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && activeTab === 'code' && fileData && (
            <div className="code-peek-source-wrap">
              {fileData.startLine > 1 && (
                <button
                  type="button"
                  className="code-peek-load-more-btn"
                  onClick={() => void handleLoadEarlierLines()}
                  disabled={loadingMore === 'up'}
                >
                  <ArrowUp size={13} />
                  <span>
                    {loadingMore === 'up'
                      ? 'Loading earlier lines…'
                      : `↑ Load earlier lines (L1–L${fileData.startLine - 1})`}
                  </span>
                </button>
              )}

              {fileData.isBinary ? (
                <div className="code-peek-state">
                  Binary file ({fileData.path}) — preview omitted in text inspector.
                </div>
              ) : (
                <div className="code-peek-lines" role="region" aria-label={`Source code for ${fileData.path}`}>
                  {fileData.lines.map((line) => {
                    const isHighlighted =
                      highlightStart !== undefined &&
                      highlightEnd !== undefined &&
                      line.lineNumber >= highlightStart &&
                      line.lineNumber <= highlightEnd;

                    return (
                      <div
                        key={line.lineNumber}
                        data-line-number={line.lineNumber}
                        className={`code-peek-line${isHighlighted ? ' is-highlighted' : ''}`}
                      >
                        <button
                          type="button"
                          className="code-peek-line-num"
                          onClick={(e) => handleClickLineNumber(line.lineNumber, e.shiftKey)}
                          title="Click to highlight line (Shift+Click for range)"
                        >
                          {line.lineNumber}
                        </button>
                        <pre className="code-peek-line-code">
                          <code>{line.text || ' '}</code>
                        </pre>
                      </div>
                    );
                  })}
                </div>
              )}

              {fileData.endLine < fileData.totalLines && (
                <button
                  type="button"
                  className="code-peek-load-more-btn"
                  onClick={() => void handleLoadMoreLines()}
                  disabled={loadingMore === 'down'}
                >
                  <ArrowDown size={13} />
                  <span>
                    {loadingMore === 'down'
                      ? 'Loading more lines…'
                      : `↓ Load more lines (L${fileData.endLine + 1}–L${fileData.totalLines})`}
                  </span>
                </button>
              )}
            </div>
          )}

          {!loading && !error && activeTab !== 'code' && gitData && (
            <div className="code-peek-git-wrap">
              <div className="code-peek-git-command-bar">
                <code className="code-peek-git-cmd">$ {gitData.command}</code>
                {gitData.observedCommits.length > 0 && (
                  <div className="code-peek-git-commits-strip">
                    {gitData.observedCommits.slice(0, 8).map((sha) => (
                      <button
                        key={sha}
                        type="button"
                        className="code-peek-commit-pill"
                        onClick={() =>
                          onSelectTarget({
                            kind: 'git',
                            commitSha: sha,
                            path: target.path,
                            gitSubcommand: 'show',
                          })
                        }
                        title={`Inspect commit ${sha}`}
                      >
                        <GitCommitHorizontal size={11} />
                        <span>{sha.slice(0, 8)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="code-peek-diff">
                {gitData.output.split('\n').map((line, index) => (
                  <div key={index} className={classifyDiffLine(line)}>
                    <span className="diff-line-num">{index + 1}</span>
                    <pre className="diff-line-text">
                      <code>{line || ' '}</code>
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 1-Click "Ask Scavenger" Footer Actions */}
        <footer className="code-peek-footer">
          <div className="code-peek-footer-actions">
            <button
              type="button"
              className="code-peek-action-btn is-primary"
              onClick={handleExplainSlice}
              disabled={disabled || loading}
            >
              <Sparkles size={14} />
              <span>Explain this slice</span>
            </button>

            <button
              type="button"
              className="code-peek-action-btn"
              onClick={handleWhatBreaks}
              disabled={disabled || loading}
            >
              <GitBranch size={14} />
              <span>What breaks if this changes?</span>
            </button>
          </div>

          <button
            type="button"
            className="code-peek-copy-btn"
            onClick={() => void handleCopyContent()}
            disabled={loading}
            title="Copy code slice to clipboard"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied ? 'Copied' : 'Copy slice'}</span>
          </button>
        </footer>
      </aside>
    </div>
  );
}
