import {
  AlertCircle,
  ArrowUp,
  ChevronRight,
  CornerDownLeft,
  Eye,
  EyeOff,
  Folder,
  FolderGit2,
  HardDrive,
  Home,
  Link2,
  Loader2,
  Pencil,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DirectoryBrowseResponse, DirectoryShortcut } from '../../shared/types';
import { browseDirectory } from '../api/client';

interface FileExplorerModalProps {
  initialPath?: string;
  onSelect: (selectedPath: string) => void;
  onClose: () => void;
}

function ShortcutIcon({ kind }: { kind: DirectoryShortcut['kind'] }) {
  switch (kind) {
    case 'home':
      return <Home size={15} />;
    case 'workspace':
      return <FolderGit2 size={15} />;
    case 'root':
      return <HardDrive size={15} />;
    default:
      return <Folder size={15} />;
  }
}

export function FileExplorerModal({ initialPath, onSelect, onClose }: FileExplorerModalProps) {
  const [data, setData] = useState<DirectoryBrowseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const backdropMouseDownRef = useRef(false);
  const breadcrumbsRef = useRef<HTMLDivElement | null>(null);
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const loadDirectory = useCallback(
    async (
      targetPath: string | undefined,
      options?: { showHidden?: boolean; fallback?: boolean }
    ) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      try {
        const res = await browseDirectory(
          {
            path: targetPath,
            showHidden: options?.showHidden ?? showHidden,
            fallback: options?.fallback ?? false,
          },
          controller.signal
        );
        setData(res);
        setHighlightedPath(null);
        setFilterQuery('');
        setEditingPath(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        setError(err instanceof Error ? err.message : 'Unable to open directory.');
      } finally {
        if (abortRef.current === controller) {
          setLoading(false);
        }
      }
    },
    [showHidden]
  );

  // Initial directory load on mount (uses fallback so partial/invalid input lands on nearest valid parent)
  useEffect(() => {
    void loadDirectory(initialPath, { showHidden: false, fallback: true });
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep deepest breadcrumb visible after navigation
  useEffect(() => {
    const el = breadcrumbsRef.current;
    if (el) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [data?.currentPath]);

  // Focus & select path draft when entering manual path edit mode
  useEffect(() => {
    if (editingPath) {
      pathInputRef.current?.focus();
      pathInputRef.current?.select();
    }
  }, [editingPath]);

  const filteredEntries = useMemo(() => {
    if (!data) return [];
    const q = filterQuery.trim().toLowerCase();
    if (!q) return data.entries;
    return data.entries.filter((entry) => entry.name.toLowerCase().includes(q));
  }, [data, filterQuery]);

  const activeHighlightedEntry = useMemo(() => {
    if (!highlightedPath) return null;
    return filteredEntries.find((entry) => entry.path === highlightedPath) ?? null;
  }, [filteredEntries, highlightedPath]);

  const effectivePath = activeHighlightedEntry?.path ?? data?.currentPath ?? '';
  const effectiveIsGitRepo = activeHighlightedEntry
    ? activeHighlightedEntry.isGitRepo
    : (data?.isCurrentGitRepo ?? false);

  // Scroll highlighted row into view during keyboard navigation
  useEffect(() => {
    if (!activeHighlightedEntry) return;
    const rowEl = rowRefs.current.get(activeHighlightedEntry.path);
    rowEl?.scrollIntoView({ block: 'nearest' });
  }, [activeHighlightedEntry]);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (editingPath) {
          setEditingPath(false);
        } else if (document.activeElement === filterInputRef.current && filterQuery) {
          setFilterQuery('');
        } else {
          onClose();
        }
        return;
      }

      if (editingPath) {
        return;
      }

      const activeTag = (document.activeElement?.tagName ?? '').toUpperCase();
      const inInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA';

      if (e.key === 'ArrowDown') {
        if (filteredEntries.length === 0) return;
        e.preventDefault();
        const currentIdx = activeHighlightedEntry
          ? filteredEntries.findIndex((entry) => entry.path === activeHighlightedEntry.path)
          : -1;
        const nextIdx = currentIdx < filteredEntries.length - 1 ? currentIdx + 1 : 0;
        setHighlightedPath(filteredEntries[nextIdx].path);
        return;
      }

      if (e.key === 'ArrowUp') {
        if (filteredEntries.length === 0) return;
        e.preventDefault();
        const currentIdx = activeHighlightedEntry
          ? filteredEntries.findIndex((entry) => entry.path === activeHighlightedEntry.path)
          : 0;
        const prevIdx = currentIdx > 0 ? currentIdx - 1 : filteredEntries.length - 1;
        setHighlightedPath(filteredEntries[prevIdx].path);
        return;
      }

      if (e.key === 'Enter') {
        if ((e.metaKey || e.ctrlKey) && effectivePath) {
          e.preventDefault();
          onSelect(effectivePath);
          return;
        }
        if (activeHighlightedEntry && activeTag !== 'BUTTON') {
          e.preventDefault();
          void loadDirectory(activeHighlightedEntry.path);
        }
        return;
      }

      if (!inInput && e.key === 'ArrowRight' && activeHighlightedEntry) {
        e.preventDefault();
        void loadDirectory(activeHighlightedEntry.path);
        return;
      }

      if (!inInput && (e.key === 'ArrowLeft' || e.key === 'Backspace') && data?.parentPath) {
        e.preventDefault();
        void loadDirectory(data.parentPath);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activeHighlightedEntry,
    data?.parentPath,
    editingPath,
    effectivePath,
    filterQuery,
    filteredEntries,
    loadDirectory,
    onClose,
    onSelect,
  ]);

  function handleStartEditPath() {
    setPathDraft(data?.currentPath ?? initialPath ?? '');
    setEditingPath(true);
    setError(null);
  }

  function handleSubmitPath(e: React.FormEvent) {
    e.preventDefault();
    const target = pathDraft.trim();
    if (!target) return;
    void loadDirectory(target, { fallback: false });
  }

  function handleToggleHidden() {
    const next = !showHidden;
    setShowHidden(next);
    void loadDirectory(data?.currentPath ?? initialPath, {
      showHidden: next,
      fallback: !data,
    });
  }

  function handleConfirm() {
    if (!effectivePath) return;
    onSelect(effectivePath);
  }

  const homeShortcut = data?.shortcuts.find((s) => s.kind === 'home');

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        backdropMouseDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropMouseDownRef.current) {
          onClose();
        }
        backdropMouseDownRef.current = false;
      }}
    >
      <div
        className="modal-panel file-explorer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-explorer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="explorer-header-title">
            <h3 id="file-explorer-title">Select Repository Folder</h3>
            <span className="explorer-readonly-tag">Read-only browse</span>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Navigation toolbar: Up + Breadcrumbs / Editable Path */}
        <div className="explorer-toolbar">
          <button
            type="button"
            className="explorer-nav-btn"
            disabled={!data?.parentPath || loading}
            onClick={() => data?.parentPath && void loadDirectory(data.parentPath)}
            title="Go to parent folder (Backspace)"
            aria-label="Go to parent folder"
          >
            <ArrowUp size={15} />
          </button>

          {editingPath ? (
            <form className="explorer-path-form" onSubmit={handleSubmitPath}>
              <input
                ref={pathInputRef}
                type="text"
                className="explorer-path-input"
                value={pathDraft}
                onChange={(e) => setPathDraft(e.target.value)}
                placeholder="/path/to/folder or ~/projects"
                aria-label="Jump to directory path"
              />
              <button
                type="submit"
                className="explorer-path-go-btn"
                disabled={!pathDraft.trim() || loading}
                title="Go to path"
              >
                <CornerDownLeft size={14} />
                <span>Go</span>
              </button>
              <button
                type="button"
                className="explorer-nav-btn"
                onClick={() => setEditingPath(false)}
                title="Cancel editing path"
                aria-label="Cancel editing path"
              >
                <X size={14} />
              </button>
            </form>
          ) : (
            <div className="explorer-breadcrumb-bar">
              <div
                ref={breadcrumbsRef}
                className="explorer-breadcrumbs"
                aria-label="Current directory path"
              >
                {data?.breadcrumbs.map((crumb, idx) => {
                  const isLast = idx === data.breadcrumbs.length - 1;
                  return (
                    <span key={crumb.path} className="explorer-breadcrumb-item">
                      {idx > 0 && <ChevronRight size={13} className="explorer-breadcrumb-sep" />}
                      <button
                        type="button"
                        className={`explorer-breadcrumb-btn ${isLast ? 'current' : ''}`}
                        onClick={() => {
                          if (!isLast) void loadDirectory(crumb.path);
                        }}
                        disabled={loading && !isLast}
                        title={crumb.path}
                      >
                        {crumb.name}
                      </button>
                    </span>
                  );
                })}
              </div>
              <button
                type="button"
                className="explorer-edit-path-btn"
                onClick={handleStartEditPath}
                title="Type or paste a directory path"
                aria-label="Edit path directly"
              >
                <Pencil size={13} />
              </button>
            </div>
          )}
        </div>

        {/* Filter & hidden folders bar */}
        <div className="explorer-subbar">
          <div className="explorer-filter-box">
            <Search size={14} className="explorer-filter-icon" />
            <input
              ref={filterInputRef}
              type="text"
              className="explorer-filter-input"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Filter folders in this directory…"
              aria-label="Filter folders in this directory"
            />
            {filterQuery && (
              <button
                type="button"
                className="explorer-filter-clear"
                onClick={() => setFilterQuery('')}
                aria-label="Clear filter"
              >
                <X size={13} />
              </button>
            )}
          </div>

          <button
            type="button"
            className={`explorer-toggle-btn ${showHidden ? 'active' : ''}`}
            onClick={handleToggleHidden}
            aria-pressed={showHidden}
            title="Show or hide dot-directories"
          >
            {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
            <span>Hidden</span>
          </button>
        </div>

        {/* Two-pane main explorer */}
        <div className="explorer-layout">
          <aside className="explorer-sidebar" aria-label="Quick places">
            <div className="explorer-sidebar-label">Places</div>
            <div className="explorer-shortcuts">
              {(data?.shortcuts ?? []).map((shortcut) => {
                const isActive = data?.currentPath === shortcut.path;
                return (
                  <button
                    key={shortcut.path}
                    type="button"
                    className={`explorer-shortcut-btn ${isActive ? 'active' : ''}`}
                    onClick={() => void loadDirectory(shortcut.path)}
                    title={shortcut.path}
                  >
                    <ShortcutIcon kind={shortcut.kind} />
                    <span>{shortcut.label}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="explorer-main">
            {data && (
              <div className="explorer-status-bar">
                <div className="explorer-status-meta">
                  <span>
                    {data.entries.length === 1 ? '1 folder' : `${data.entries.length} folders`}
                    {data.fileCount > 0
                      ? ` · ${data.fileCount === 1 ? '1 file' : `${data.fileCount} files`}`
                      : ''}
                  </span>
                  {data.truncated && (
                    <span className="explorer-truncated-note">(capped at first 500)</span>
                  )}
                </div>

                {data.isCurrentGitRepo && (
                  <span className="explorer-git-badge">
                    <FolderGit2 size={12} />
                    <span>Git repository</span>
                  </span>
                )}
              </div>
            )}

            {error && (
              <div className="explorer-error-bar" role="alert">
                <AlertCircle size={15} className="explorer-error-icon" />
                <span className="explorer-error-text">{error}</span>
                <div className="explorer-error-actions">
                  {data?.parentPath && (
                    <button
                      type="button"
                      className="explorer-inline-btn"
                      onClick={() => void loadDirectory(data.parentPath!)}
                    >
                      Go Up
                    </button>
                  )}
                  {homeShortcut && (
                    <button
                      type="button"
                      className="explorer-inline-btn"
                      onClick={() => void loadDirectory(homeShortcut.path)}
                    >
                      Home
                    </button>
                  )}
                  <button
                    type="button"
                    className="explorer-inline-dismiss"
                    onClick={() => setError(null)}
                    aria-label="Dismiss error"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            )}

            <div className="explorer-list-wrap">
              {loading && !data ? (
                <div className="explorer-empty">
                  <Loader2 size={20} className="explorer-spinner" />
                  <span>Loading folders…</span>
                </div>
              ) : !data ? (
                <div className="explorer-empty">
                  <span>Unable to browse filesystem.</span>
                  <button
                    type="button"
                    className="chip-button"
                    onClick={() => void loadDirectory(undefined, { fallback: true })}
                  >
                    Retry from Home
                  </button>
                </div>
              ) : filteredEntries.length === 0 ? (
                <div className="explorer-empty">
                  {filterQuery.trim() ? (
                    <>
                      <span>No folders matching &ldquo;{filterQuery.trim()}&rdquo;.</span>
                      <button
                        type="button"
                        className="chip-button"
                        onClick={() => setFilterQuery('')}
                      >
                        Clear filter
                      </button>
                    </>
                  ) : (
                    <>
                      <Folder size={22} className="explorer-empty-icon" />
                      <span>
                        No subfolders here.
                        {data.isCurrentGitRepo
                          ? ' This directory is a Git repository—click Select Folder to choose it.'
                          : ' Click Select Folder to use this directory.'}
                      </span>
                    </>
                  )}
                </div>
              ) : (
                <div
                  className={`explorer-list ${loading ? 'is-loading' : ''}`}
                  role="listbox"
                  aria-label="Subfolders"
                >
                  {filteredEntries.map((entry) => {
                    const isSelected = activeHighlightedEntry?.path === entry.path;
                    return (
                      <div
                        key={entry.path}
                        ref={(el) => {
                          if (el) rowRefs.current.set(entry.path, el);
                          else rowRefs.current.delete(entry.path);
                        }}
                        role="option"
                        aria-selected={isSelected}
                        tabIndex={0}
                        className={`explorer-row ${isSelected ? 'selected' : ''} ${
                          entry.isHidden ? 'is-hidden-entry' : ''
                        }`}
                        onClick={() => setHighlightedPath(entry.path)}
                        onDoubleClick={() => void loadDirectory(entry.path)}
                        onKeyDown={(e) => {
                          if (e.key === ' ') {
                            e.preventDefault();
                            setHighlightedPath(entry.path);
                          }
                        }}
                      >
                        <span
                          className={`explorer-row-icon ${entry.isGitRepo ? 'is-git' : ''}`}
                          aria-hidden="true"
                        >
                          {entry.isGitRepo ? <FolderGit2 size={17} /> : <Folder size={17} />}
                        </span>

                        <span className="explorer-row-name" title={entry.path}>
                          {entry.name}
                        </span>

                        {entry.isSymlink && (
                          <span className="explorer-symlink-tag" title="Symbolic link">
                            <Link2 size={12} />
                          </span>
                        )}

                        {entry.isGitRepo && <span className="explorer-git-pill">git</span>}

                        <button
                          type="button"
                          className="explorer-row-open-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            void loadDirectory(entry.path);
                          }}
                          title={`Open ${entry.name}`}
                          aria-label={`Open ${entry.name}`}
                        >
                          <ChevronRight size={15} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Footer with selected target path & confirm */}
        <div className="modal-footer explorer-footer">
          <div className="explorer-selection-preview">
            <div className="explorer-selection-top">
              <span className="explorer-selection-label">
                {activeHighlightedEntry ? 'Selected folder' : 'Current folder'}
              </span>
              {effectiveIsGitRepo && <span className="explorer-git-pill">git</span>}
              <span className="explorer-selection-hint">· Double-click to open</span>
            </div>
            <div className="explorer-selection-path" title={effectivePath}>
              {effectivePath || '—'}
            </div>
          </div>

          <div className="explorer-footer-actions">
            <button type="button" className="chip-button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-pill-btn"
              disabled={!effectivePath || (loading && !data)}
              onClick={handleConfirm}
            >
              Select Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
