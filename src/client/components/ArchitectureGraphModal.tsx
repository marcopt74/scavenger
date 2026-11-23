import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BookOpen,
  Code2,
  Compass,
  FileCode2,
  Layers,
  Loader2,
  Network,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CodePeekTarget,
  KnowledgeGraphModuleNode,
  KnowledgeGraphResponse,
  RepoCoreFlow,
  RepoFileIndexEntry,
  SessionPublicState,
  TopicMastery,
} from '../../shared/types';
import { fetchKnowledgeGraph } from '../api/client';
import {
  ARCH_LAYER_META,
  computeArchitectureGraphLayout,
  computeBlastRadius,
  computeFlowHighlight,
  filterArchitectureModules,
  resolveModuleIdForFile,
} from '../utils/graphLayout';

export interface ArchitectureGraphModalProps {
  session: SessionPublicState;
  disabled?: boolean;
  onClose: () => void;
  onSelectModuleToLearn: (moduleId: string, prompt: string) => void;
  onOpenFilePeek: (target: CodePeekTarget) => void;
}

export type GraphOverlayMode = 'architecture' | 'mastery';

const MIN_ZOOM = 0.45;
const MAX_ZOOM = 2.4;
const ZOOM_STEP = 0.2;

const MASTERY_META: Record<
  TopicMastery,
  { label: string; color: string; bg: string; border: string }
> = {
  solid: {
    label: 'Solid',
    color: '#10b981',
    bg: 'rgba(16, 185, 129, 0.14)',
    border: '#10b981',
  },
  developing: {
    label: 'Developing',
    color: '#3b82f6',
    bg: 'rgba(59, 130, 246, 0.14)',
    border: '#3b82f6',
  },
  introduced: {
    label: 'Introduced',
    color: '#f59e0b',
    bg: 'rgba(245, 158, 11, 0.14)',
    border: '#f59e0b',
  },
  unexplored: {
    label: 'Unexplored',
    color: '#64748b',
    bg: 'rgba(100, 116, 139, 0.12)',
    border: '#94a3b8',
  },
};

type NodeRelationRole =
  | 'selected'
  | 'direct-upstream'
  | 'transitive-upstream'
  | 'direct-downstream'
  | 'transitive-downstream'
  | 'flow-step'
  | 'none';

const ROLE_BADGE_META: Record<
  Exclude<NodeRelationRole, 'none'>,
  { label: string; color: string; bg: string }
> = {
  selected: {
    label: 'Selected',
    color: '#2563eb',
    bg: 'rgba(37, 99, 235, 0.16)',
  },
  'direct-upstream': {
    label: 'Direct Caller',
    color: '#d97706',
    bg: 'rgba(217, 119, 6, 0.16)',
  },
  'transitive-upstream': {
    label: 'Transitive Caller',
    color: '#ea580c',
    bg: 'rgba(234, 88, 12, 0.14)',
  },
  'direct-downstream': {
    label: 'Direct Dependency',
    color: '#0891b2',
    bg: 'rgba(8, 145, 178, 0.16)',
  },
  'transitive-downstream': {
    label: 'Transitive Dep',
    color: '#6366f1',
    bg: 'rgba(99, 102, 241, 0.14)',
  },
  'flow-step': {
    label: 'Flow Step',
    color: '#7c3aed',
    bg: 'rgba(124, 58, 237, 0.16)',
  },
};

function truncateText(text: string, maxLen: number): string {
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

export function ArchitectureGraphModal({
  session,
  disabled = false,
  onClose,
  onSelectModuleToLearn,
  onOpenFilePeek,
}: ArchitectureGraphModalProps) {
  const [graph, setGraph] = useState<KnowledgeGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [overlayMode, setOverlayMode] = useState<GraphOverlayMode>('architecture');
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [activeFlowId, setActiveFlowId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const dragOriginRef = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
    moved: boolean;
  } | null>(null);
  const backdropMouseDownRef = useRef(false);

  async function loadGraphData() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchKnowledgeGraph(session.id);
      setGraph(response);
      if (response.modules.length > 0 && !selectedModuleId) {
        const entryOrFirst =
          response.modules.find((m) => m.layer === 'entry') ??
          response.modules.find((m) => m.layer === 'core') ??
          response.modules[0];
        if (entryOrFirst) {
          setSelectedModuleId(entryOrFirst.id);
        }
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load architecture graph.'
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadGraphData();
  }, [session.id]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const modules = graph?.modules ?? [];
  const coreFlows = graph?.summary?.coreFlows ?? [];
  const allFiles = graph?.files ?? [];

  const moduleById = useMemo(() => {
    const map = new Map<string, KnowledgeGraphModuleNode>();
    for (const mod of modules) {
      map.set(mod.id, mod);
    }
    return map;
  }, [modules]);

  const layout = useMemo(
    () => computeArchitectureGraphLayout(modules, coreFlows),
    [modules, coreFlows]
  );

  const blastRadius = useMemo(() => {
    if (!selectedModuleId || !moduleById.has(selectedModuleId)) return null;
    return computeBlastRadius(modules, selectedModuleId);
  }, [modules, selectedModuleId, moduleById]);

  const activeFlow: RepoCoreFlow | null = useMemo(() => {
    if (!activeFlowId) return null;
    return coreFlows.find((f) => f.id === activeFlowId) ?? null;
  }, [coreFlows, activeFlowId]);

  const flowHighlight = useMemo(() => {
    if (!activeFlow) return null;
    return computeFlowHighlight(activeFlow, modules, allFiles);
  }, [activeFlow, modules, allFiles]);

  const matchingModuleIds = useMemo(
    () => filterArchitectureModules(modules, searchQuery, allFiles),
    [modules, searchQuery, allFiles]
  );

  const selectedModule = selectedModuleId
    ? moduleById.get(selectedModuleId) ?? null
    : null;

  const selectedModuleFiles: RepoFileIndexEntry[] = useMemo(() => {
    if (!selectedModule) return [];
    const indexedForModule = allFiles.filter(
      (f) => f.moduleId === selectedModule.id
    );
    if (indexedForModule.length > 0) {
      return indexedForModule.sort((a, b) => a.path.localeCompare(b.path));
    }
    return (selectedModule.files ?? []).map((path) => ({
      path,
      moduleId: selectedModule.id,
      language: path.split('.').pop() || 'text',
      lines: 0,
      sizeBytes: 0,
      mtimeMs: 0,
      exports: [],
      imports: [],
    }));
  }, [selectedModule, allFiles]);

  const blastSetLookup = useMemo(() => {
    if (!blastRadius) {
      return {
        directUpstream: new Set<string>(),
        transitiveUpstream: new Set<string>(),
        directDownstream: new Set<string>(),
        transitiveDownstream: new Set<string>(),
      };
    }
    return {
      directUpstream: new Set(blastRadius.directUpstream),
      transitiveUpstream: new Set(blastRadius.transitiveUpstream),
      directDownstream: new Set(blastRadius.directDownstream),
      transitiveDownstream: new Set(blastRadius.transitiveDownstream),
    };
  }, [blastRadius]);

  const flowEdgeSet = useMemo(
    () => new Set(flowHighlight?.edgeIds ?? []),
    [flowHighlight]
  );

  const flowModuleSet = useMemo(
    () => new Set(flowHighlight?.moduleIds ?? []),
    [flowHighlight]
  );

  function getNodeRelationRole(moduleId: string): NodeRelationRole {
    if (activeFlow && flowModuleSet.has(moduleId)) {
      if (selectedModuleId === moduleId) return 'selected';
      return 'flow-step';
    }
    if (!selectedModuleId) return 'none';
    if (moduleId === selectedModuleId) return 'selected';
    if (blastSetLookup.directUpstream.has(moduleId)) return 'direct-upstream';
    if (blastSetLookup.transitiveUpstream.has(moduleId))
      return 'transitive-upstream';
    if (blastSetLookup.directDownstream.has(moduleId)) return 'direct-downstream';
    if (blastSetLookup.transitiveDownstream.has(moduleId))
      return 'transitive-downstream';
    return 'none';
  }

  function handleResetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.12 : -0.12;
    setZoom((z) =>
      Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((z + delta).toFixed(2))))
    );
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-graph-node="true"]')) {
      return;
    }
    setDragging(true);
    dragOriginRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
      moved: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragging || !dragOriginRef.current) return;
    const dx = e.clientX - dragOriginRef.current.x;
    const dy = e.clientY - dragOriginRef.current.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      dragOriginRef.current.moved = true;
    }
    setPan({
      x: dragOriginRef.current.panX + dx,
      y: dragOriginRef.current.panY + dy,
    });
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (!dragging) return;
    setDragging(false);
    dragOriginRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore if capture already released
    }
  }

  function handleToggleFlow(flowId: string) {
    if (activeFlowId === flowId) {
      setActiveFlowId(null);
      return;
    }
    setActiveFlowId(flowId);
    const targetFlow = coreFlows.find((f) => f.id === flowId);
    if (targetFlow) {
      const highlight = computeFlowHighlight(targetFlow, modules, allFiles);
      if (highlight.moduleIds.length > 0) {
        setSelectedModuleId(highlight.moduleIds[0]);
      }
    }
  }

  function handleTeachModule(mod: KnowledgeGraphModuleNode) {
    const sampleFiles = (mod.files ?? []).slice(0, 3).join(', ');
    const symbolsNote =
      mod.keySymbols && mod.keySymbols.length > 0
        ? ` focusing on key symbols (${mod.keySymbols.slice(0, 5).join(', ')})`
        : '';
    const prompt = `Walk me through the "${mod.name}" module (\`${mod.path}\`, ${mod.layer} layer)${symbolsNote}. Explain its architectural responsibility, how it interacts with its upstream callers and downstream dependencies, and cite concrete files${sampleFiles ? ` like ${sampleFiles}` : ''}.`;
    onSelectModuleToLearn(mod.id, prompt);
    onClose();
  }

  function handleAnalyzeBlastRadius(mod: KnowledgeGraphModuleNode) {
    const callerList =
      blastRadius && blastRadius.directUpstream.length > 0
        ? ` Direct callers include: ${blastRadius.directUpstream.join(', ')}.`
        : '';
    const prompt = `Analyze the blast radius of changing the "${mod.name}" module (\`${mod.path}\`).${callerList} What contracts or exported symbols does it expose, which upstream modules and execution flows would break if those contracts changed, and what safeguards should I verify?`;
    onSelectModuleToLearn(mod.id, prompt);
    onClose();
  }

  return (
    <div
      className="modal-backdrop arch-graph-backdrop"
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
        className="modal-panel arch-graph-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="arch-graph-modal-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(1440px, 96vw)',
          height: 'min(880px, 92vh)',
          maxWidth: '96vw',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Modal Header */}
        <div className="modal-header arch-graph-header">
          <div className="settings-header-copy">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Network size={18} style={{ color: 'var(--accent)' }} />
              <h3 id="arch-graph-modal-title" style={{ margin: 0 }}>
                Architecture & Dependency Graph Studio
              </h3>
              {graph && (
                <span className="pill-badge">
                  {graph.modules.length} modules · {layout.edges.length} edges
                </span>
              )}
            </div>
            <span className="settings-header-sub">
              Explore layered module dependencies, inspect change blast radius, trace core execution flows, and jump directly into source files
            </span>
          </div>

          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close Architecture Graph Studio"
            title="Close (Esc)"
          >
            <X size={18} />
          </button>
        </div>

        {/* Top Studio Controls Bar */}
        <div
          className="arch-studio-toolbar"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            padding: '10px 18px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--bg-surface)',
          }}
        >
          {/* Left: Mode Toggle & Search */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              flexWrap: 'wrap',
            }}
          >
            <div
              className="arch-mode-toggle"
              role="group"
              aria-label="Graph overlay mode"
              style={{
                display: 'inline-flex',
                background: 'var(--bg-subtle)',
                padding: '3px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
                gap: '3px',
              }}
            >
              <button
                type="button"
                className={`arch-mode-btn ${
                  overlayMode === 'architecture' ? 'active' : ''
                }`}
                onClick={() => setOverlayMode('architecture')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '5px 10px',
                  borderRadius: '6px',
                  border: 'none',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  background:
                    overlayMode === 'architecture'
                      ? 'var(--bg-page)'
                      : 'transparent',
                  color:
                    overlayMode === 'architecture'
                      ? 'var(--accent)'
                      : 'var(--text-secondary)',
                  boxShadow:
                    overlayMode === 'architecture'
                      ? 'var(--shadow-soft)'
                      : 'none',
                }}
              >
                <Layers size={14} />
                <span>Architecture & Blast Radius</span>
              </button>
              <button
                type="button"
                className={`arch-mode-btn ${
                  overlayMode === 'mastery' ? 'active' : ''
                }`}
                onClick={() => setOverlayMode('mastery')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '5px 10px',
                  borderRadius: '6px',
                  border: 'none',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  background:
                    overlayMode === 'mastery' ? 'var(--bg-page)' : 'transparent',
                  color:
                    overlayMode === 'mastery'
                      ? 'var(--accent)'
                      : 'var(--text-secondary)',
                  boxShadow:
                    overlayMode === 'mastery' ? 'var(--shadow-soft)' : 'none',
                }}
              >
                <Activity size={14} />
                <span>Mastery Overlay</span>
              </button>
            </div>

            {/* Search Input */}
            <div
              className="arch-search-box"
              style={{
                position: 'relative',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              <Search
                size={14}
                style={{
                  position: 'absolute',
                  left: '10px',
                  color: 'var(--text-muted)',
                  pointerEvents: 'none',
                }}
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter module, symbol, or file…"
                aria-label="Filter modules by name, symbol, or file path"
                className="arch-search-input"
                style={{
                  padding: '5px 28px 5px 30px',
                  fontSize: '0.8rem',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-page)',
                  color: 'var(--text-primary)',
                  minWidth: '220px',
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear filter"
                  style={{
                    position: 'absolute',
                    right: '6px',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: '2px',
                    display: 'inline-flex',
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          {/* Right: Zoom & Reset Controls */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <div
              className="lightbox-zoom-group"
              aria-label="Canvas zoom controls"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                background: 'var(--bg-subtle)',
                padding: '3px 6px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <button
                type="button"
                className="lightbox-tool-btn"
                onClick={() =>
                  setZoom((z) =>
                    Math.max(MIN_ZOOM, Number((z - ZOOM_STEP).toFixed(2)))
                  )
                }
                disabled={zoom <= MIN_ZOOM}
                title="Zoom out"
                aria-label="Zoom out"
              >
                <ZoomOut size={14} />
              </button>
              <span
                className="lightbox-zoom-label"
                style={{
                  fontSize: '0.76rem',
                  fontWeight: 600,
                  minWidth: '42px',
                  textAlign: 'center',
                }}
              >
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                className="lightbox-tool-btn"
                onClick={() =>
                  setZoom((z) =>
                    Math.min(MAX_ZOOM, Number((z + ZOOM_STEP).toFixed(2)))
                  )
                }
                disabled={zoom >= MAX_ZOOM}
                title="Zoom in"
                aria-label="Zoom in"
              >
                <ZoomIn size={14} />
              </button>
              <button
                type="button"
                className="lightbox-tool-btn"
                onClick={handleResetView}
                disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
                title="Reset zoom (100%)"
                aria-label="Reset zoom"
                style={{
                  fontSize: '0.74rem',
                  padding: '2px 6px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <RotateCcw size={13} />
                <span>Reset (100%)</span>
              </button>
            </div>
          </div>
        </div>

        {/* Core Execution Flow Selector Pill Bar */}
        {coreFlows.length > 0 && (
          <div
            className="arch-flow-bar"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 18px',
              borderBottom: '1px solid var(--border-subtle)',
              background: 'var(--bg-subtle)',
              overflowX: 'auto',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '0.75rem',
                fontWeight: 600,
                color: 'var(--text-secondary)',
                whiteSpace: 'nowrap',
              }}
            >
              <Zap size={13} style={{ color: '#7c3aed' }} />
              Core Execution Flows:
            </span>
            {coreFlows.map((flow) => {
              const isSelected = activeFlowId === flow.id;
              return (
                <button
                  key={flow.id}
                  type="button"
                  className={`arch-flow-pill ${isSelected ? 'active' : ''}`}
                  onClick={() => handleToggleFlow(flow.id)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '4px 11px',
                    borderRadius: 'var(--radius-pill)',
                    fontSize: '0.76rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    border: isSelected
                      ? '1px solid #7c3aed'
                      : '1px solid var(--border-subtle)',
                    background: isSelected
                      ? 'rgba(124, 58, 237, 0.14)'
                      : 'var(--bg-page)',
                    color: isSelected ? '#7c3aed' : 'var(--text-primary)',
                  }}
                >
                  <span>Flow: {flow.name}</span>
                </button>
              );
            })}
            {activeFlowId && (
              <button
                type="button"
                onClick={() => setActiveFlowId(null)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '2px 6px',
                  whiteSpace: 'nowrap',
                }}
              >
                Clear flow highlight
              </button>
            )}
          </div>
        )}

        {/* Main Studio Split Area: Interactive SVG Canvas + Right Inspector */}
        <div
          className="arch-studio-body"
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: '1fr 370px',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          {/* Left: Interactive SVG Canvas */}
          <div
            className={`arch-canvas-viewport ${dragging ? 'is-dragging' : ''}`}
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            style={{
              position: 'relative',
              overflow: 'hidden',
              background: 'var(--bg-page)',
              cursor: dragging ? 'grabbing' : 'grab',
              userSelect: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {loading ? (
              <div
                className="arch-graph-loading"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '10px',
                  color: 'var(--text-secondary)',
                }}
              >
                <Loader2 size={26} className="spin" />
                <span>Building layered architecture & dependency graph…</span>
              </div>
            ) : error ? (
              <div
                className="arch-graph-error"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '24px',
                  textAlign: 'center',
                }}
              >
                <AlertTriangle size={28} style={{ color: 'var(--danger)' }} />
                <p style={{ margin: 0, color: 'var(--text-primary)' }}>{error}</p>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void loadGraphData()}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <RefreshCw size={14} />
                  <span>Retry</span>
                </button>
              </div>
            ) : layout.nodes.length === 0 ? (
              <div
                style={{
                  color: 'var(--text-muted)',
                  fontSize: '0.9rem',
                  textAlign: 'center',
                  padding: '32px',
                }}
              >
                No repository modules indexed yet.
              </div>
            ) : (
              <>
                <div
                  className="arch-canvas-transform"
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: 'center center',
                    transition: dragging ? 'none' : 'transform 0.08s ease-out',
                  }}
                >
                  <svg
                    width={layout.width}
                    height={layout.height}
                    viewBox={`0 0 ${layout.width} ${layout.height}`}
                    className="arch-graph-svg"
                    role="img"
                    aria-label={`Architecture dependency graph for ${session.repoName}`}
                  >
                    <defs>
                      <marker
                        id="arch-arrow-default"
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto-start-reverse"
                      >
                        <path d="M 0 1 L 10 5 L 0 9 z" fill="#94a3b8" />
                      </marker>
                      <marker
                        id="arch-arrow-upstream"
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth="7"
                        markerHeight="7"
                        orient="auto-start-reverse"
                      >
                        <path d="M 0 1 L 10 5 L 0 9 z" fill="#f59e0b" />
                      </marker>
                      <marker
                        id="arch-arrow-downstream"
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth="7"
                        markerHeight="7"
                        orient="auto-start-reverse"
                      >
                        <path d="M 0 1 L 10 5 L 0 9 z" fill="#06b6d4" />
                      </marker>
                      <marker
                        id="arch-arrow-flow"
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth="7"
                        markerHeight="7"
                        orient="auto-start-reverse"
                      >
                        <path d="M 0 1 L 10 5 L 0 9 z" fill="#7c3aed" />
                      </marker>
                    </defs>

                    {/* Horizontal Layer Swimlanes */}
                    <g className="arch-layer-bands">
                      {layout.layerBands.map((band) => {
                        const meta = ARCH_LAYER_META[band.layer];
                        return (
                          <g
                            key={band.layer}
                            className="arch-layer-band"
                            transform={`translate(0, ${band.y})`}
                          >
                            <rect
                              x={12}
                              y={0}
                              width={layout.width - 24}
                              height={band.height}
                              rx={12}
                              fill={meta.accentColor}
                              fillOpacity={0.035}
                              stroke={meta.accentColor}
                              strokeOpacity={0.18}
                              strokeDasharray="4 4"
                            />
                            {/* Swimlane Header Tag on Left */}
                            <g transform="translate(26, 24)">
                              <rect
                                x={0}
                                y={0}
                                width={120}
                                height={24}
                                rx={6}
                                fill={meta.accentColor}
                                fillOpacity={0.14}
                              />
                              <text
                                x={10}
                                y={16}
                                fontSize={11}
                                fontWeight={700}
                                fill={meta.accentColor}
                                style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}
                              >
                                {meta.shortLabel} ({band.moduleCount})
                              </text>
                              <text
                                x={2}
                                y={42}
                                fontSize={11.5}
                                fontWeight={600}
                                fill="var(--text-secondary)"
                              >
                                {band.label}
                              </text>
                            </g>
                          </g>
                        );
                      })}
                    </g>

                    {/* Directed Cubic Bézier Dependency Edges */}
                    <g className="arch-edges-layer">
                      {layout.edges.map((edge) => {
                        const isFlowEdge = flowEdgeSet.has(edge.id);
                        const isDirectUpstreamEdge =
                          selectedModuleId !== null &&
                          edge.to === selectedModuleId &&
                          blastSetLookup.directUpstream.has(edge.from);
                        const isTransitiveUpstreamEdge =
                          selectedModuleId !== null &&
                          (blastSetLookup.directUpstream.has(edge.to) ||
                            blastSetLookup.transitiveUpstream.has(edge.to)) &&
                          (blastSetLookup.directUpstream.has(edge.from) ||
                            blastSetLookup.transitiveUpstream.has(edge.from));
                        const isDirectDownstreamEdge =
                          selectedModuleId !== null &&
                          edge.from === selectedModuleId &&
                          blastSetLookup.directDownstream.has(edge.to);
                        const isTransitiveDownstreamEdge =
                          selectedModuleId !== null &&
                          (blastSetLookup.directDownstream.has(edge.from) ||
                            blastSetLookup.transitiveDownstream.has(edge.from)) &&
                          (blastSetLookup.directDownstream.has(edge.to) ||
                            blastSetLookup.transitiveDownstream.has(edge.to));

                        let stroke = '#94a3b8';
                        let strokeWidth = 1.6;
                        let strokeOpacity = selectedModuleId || activeFlowId ? 0.22 : 0.48;
                        let markerEnd = 'url(#arch-arrow-default)';
                        let strokeDasharray: string | undefined;

                        if (isFlowEdge) {
                          stroke = '#7c3aed';
                          strokeWidth = 2.8;
                          strokeOpacity = 0.95;
                          markerEnd = 'url(#arch-arrow-flow)';
                          strokeDasharray = '6 4';
                        } else if (isDirectUpstreamEdge || isTransitiveUpstreamEdge) {
                          stroke = '#f59e0b';
                          strokeWidth = isDirectUpstreamEdge ? 2.6 : 2;
                          strokeOpacity = isDirectUpstreamEdge ? 0.95 : 0.72;
                          markerEnd = 'url(#arch-arrow-upstream)';
                        } else if (
                          isDirectDownstreamEdge ||
                          isTransitiveDownstreamEdge
                        ) {
                          stroke = '#06b6d4';
                          strokeWidth = isDirectDownstreamEdge ? 2.5 : 1.9;
                          strokeOpacity = isDirectDownstreamEdge ? 0.92 : 0.68;
                          markerEnd = 'url(#arch-arrow-downstream)';
                        }

                        return (
                          <path
                            key={edge.id}
                            d={edge.d}
                            fill="none"
                            stroke={stroke}
                            strokeWidth={strokeWidth}
                            strokeOpacity={strokeOpacity}
                            strokeDasharray={strokeDasharray}
                            markerEnd={markerEnd}
                            className={`arch-edge-path ${
                              isFlowEdge ? 'is-flow-edge' : ''
                            }`}
                          />
                        );
                      })}
                    </g>

                    {/* Module Cards */}
                    <g className="arch-nodes-layer">
                      {layout.nodes.map((node) => {
                        const { module: mod } = node;
                        const layerMeta = ARCH_LAYER_META[node.layer];
                        const masteryMeta = MASTERY_META[mod.mastery ?? 'unexplored'];
                        const relationRole = getNodeRelationRole(mod.id);
                        const isSearchMatch = matchingModuleIds.has(mod.id);
                        const flowStepNum =
                          flowHighlight?.stepByModuleId?.[mod.id];

                        const isSelected = selectedModuleId === mod.id;
                        const isDimmed =
                          !isSearchMatch ||
                          (activeFlow !== null &&
                            !flowModuleSet.has(mod.id) &&
                            !isSelected);

                        const borderColor =
                          overlayMode === 'mastery'
                            ? masteryMeta.border
                            : relationRole === 'selected'
                            ? '#2563eb'
                            : relationRole === 'direct-upstream' ||
                              relationRole === 'transitive-upstream'
                            ? '#f59e0b'
                            : relationRole === 'direct-downstream' ||
                              relationRole === 'transitive-downstream'
                            ? '#06b6d4'
                            : relationRole === 'flow-step'
                            ? '#7c3aed'
                            : layerMeta.accentColor;

                        const strokeWidth =
                          isSelected || relationRole !== 'none' ? 2.4 : 1.4;

                        const roleBadge =
                          flowStepNum !== undefined
                            ? {
                                label: `Flow Step #${flowStepNum}`,
                                color: '#7c3aed',
                                bg: 'rgba(124, 58, 237, 0.16)',
                              }
                            : relationRole !== 'none'
                            ? ROLE_BADGE_META[relationRole]
                            : null;

                        const fileCount =
                          mod.files?.length || mod.observedFileCount || 0;

                        return (
                          <g
                            key={node.id}
                            data-graph-node="true"
                            data-module-id={mod.id}
                            className={`arch-node-card ${
                              isSelected ? 'is-selected' : ''
                            }`}
                            transform={`translate(${node.x}, ${node.y})`}
                            onClick={() => setSelectedModuleId(mod.id)}
                            style={{
                              cursor: 'pointer',
                              opacity: isDimmed ? 0.28 : 1,
                              transition: 'opacity 0.15s ease',
                            }}
                          >
                            {/* Card Background */}
                            <rect
                              x={0}
                              y={0}
                              width={node.width}
                              height={node.height}
                              rx={12}
                              fill="var(--bg-surface)"
                              stroke={borderColor}
                              strokeWidth={strokeWidth}
                            />

                            {/* Top Accent Strip */}
                            <rect
                              x={1}
                              y={1}
                              width={node.width - 2}
                              height={5}
                              rx={4}
                              fill={
                                overlayMode === 'mastery'
                                  ? masteryMeta.color
                                  : borderColor
                              }
                            />

                            {/* Top Row: Layer Badge + File Count + Mastery Dot */}
                            <g transform="translate(12, 14)">
                              <rect
                                x={0}
                                y={0}
                                width={48}
                                height={18}
                                rx={4}
                                fill={layerMeta.accentColor}
                                fillOpacity={0.14}
                              />
                              <text
                                x={24}
                                y={12.5}
                                textAnchor="middle"
                                fontSize={9.5}
                                fontWeight={700}
                                fill={layerMeta.accentColor}
                                style={{ textTransform: 'uppercase' }}
                              >
                                {layerMeta.shortLabel}
                              </text>

                              <text
                                x={56}
                                y={12.5}
                                fontSize={10.5}
                                fill="var(--text-muted)"
                              >
                                {fileCount} {fileCount === 1 ? 'file' : 'files'}
                              </text>

                              {/* Mastery Dot + Label */}
                              <circle
                                cx={node.width - 28}
                                cy={9}
                                r={5}
                                fill={masteryMeta.color}
                              >
                                <title>Mastery: {masteryMeta.label}</title>
                              </circle>
                            </g>

                            {/* Module Title */}
                            <text
                              x={12}
                              y={50}
                              fontSize={13}
                              fontWeight={700}
                              fill="var(--text-strong)"
                            >
                              {truncateText(mod.name || mod.id, 24)}
                            </text>

                            {/* Module Path or Role Badge */}
                            {roleBadge ? (
                              <g transform="translate(12, 60)">
                                <rect
                                  x={0}
                                  y={0}
                                  width={Math.min(
                                    node.width - 24,
                                    roleBadge.label.length * 6.5 + 16
                                  )}
                                  height={20}
                                  rx={5}
                                  fill={roleBadge.bg}
                                />
                                <text
                                  x={8}
                                  y={13.5}
                                  fontSize={10}
                                  fontWeight={700}
                                  fill={roleBadge.color}
                                >
                                  {roleBadge.label}
                                </text>
                              </g>
                            ) : (
                              <text
                                x={12}
                                y={72}
                                fontSize={10.5}
                                fill="var(--text-muted)"
                                style={{ fontFamily: 'var(--font-mono)' }}
                              >
                                {truncateText(mod.path || mod.id, 28)}
                              </text>
                            )}
                          </g>
                        );
                      })}
                    </g>
                  </svg>
                </div>

                {/* Bottom Legend Bar inside Canvas */}
                <div
                  className="arch-canvas-legend"
                  style={{
                    position: 'absolute',
                    left: '16px',
                    bottom: '14px',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '6px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                    fontSize: '0.73rem',
                    color: 'var(--text-secondary)',
                    boxShadow: 'var(--shadow-soft)',
                  }}
                >
                  {overlayMode === 'architecture' ? (
                    <>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                        }}
                      >
                        <span
                          style={{
                            width: 9,
                            height: 9,
                            borderRadius: '50%',
                            background: '#2563eb',
                          }}
                        />
                        Selected Module
                      </span>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                        }}
                      >
                        <span
                          style={{
                            width: 9,
                            height: 9,
                            borderRadius: '50%',
                            background: '#f59e0b',
                          }}
                        />
                        Upstream Callers (Blast Radius)
                      </span>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                        }}
                      >
                        <span
                          style={{
                            width: 9,
                            height: 9,
                            borderRadius: '50%',
                            background: '#06b6d4',
                          }}
                        />
                        Downstream Dependencies
                      </span>
                      {activeFlow && (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                          }}
                        >
                          <span
                            style={{
                              width: 9,
                              height: 9,
                              borderRadius: '50%',
                              background: '#7c3aed',
                            }}
                          />
                          Active Flow Path
                        </span>
                      )}
                    </>
                  ) : (
                    Object.entries(MASTERY_META).map(([key, meta]) => (
                      <span
                        key={key}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                        }}
                      >
                        <span
                          style={{
                            width: 9,
                            height: 9,
                            borderRadius: '50%',
                            background: meta.color,
                          }}
                        />
                        {meta.label}
                      </span>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          {/* Right-Hand Inspector Panel */}
          <aside
            className="arch-inspector-panel"
            aria-label="Module and Flow Inspector"
            style={{
              borderLeft: '1px solid var(--border-subtle)',
              background: 'var(--bg-surface)',
              overflowY: 'auto',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            {/* Active Core Execution Flow Card (if selected) */}
            {activeFlow && flowHighlight && (
              <div
                className="arch-flow-inspector-card"
                style={{
                  padding: '12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'rgba(124, 58, 237, 0.07)',
                  border: '1px solid rgba(124, 58, 237, 0.28)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                  }}
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      fontSize: '0.74rem',
                      fontWeight: 700,
                      color: '#7c3aed',
                      textTransform: 'uppercase',
                    }}
                  >
                    <Zap size={13} />
                    Core Execution Flow
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveFlowId(null)}
                    aria-label="Close flow trace"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      padding: '2px',
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: '0.92rem',
                    color: 'var(--text-strong)',
                  }}
                >
                  {activeFlow.name}
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.45,
                  }}
                >
                  {activeFlow.summary}
                </p>

                {activeFlow.steps && activeFlow.steps.length > 0 && (
                  <ol
                    style={{
                      margin: '4px 0 0 0',
                      paddingLeft: '18px',
                      fontSize: '0.78rem',
                      color: 'var(--text-primary)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                    }}
                  >
                    {activeFlow.steps.map((step, idx) => (
                      <li key={idx}>{step}</li>
                    ))}
                  </ol>
                )}

                {activeFlow.files && activeFlow.files.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '5px',
                      marginTop: '4px',
                    }}
                  >
                    {activeFlow.files.map((filePath, idx) => {
                      const modId = resolveModuleIdForFile(
                        filePath,
                        modules,
                        allFiles
                      );
                      return (
                        <button
                          key={`${filePath}-${idx}`}
                          type="button"
                          onClick={() => {
                            if (modId) setSelectedModuleId(modId);
                            onOpenFilePeek({ kind: 'file', path: filePath });
                          }}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: '3px 8px',
                            fontSize: '0.73rem',
                            fontFamily: 'var(--font-mono)',
                            borderRadius: '6px',
                            border: '1px solid var(--border-subtle)',
                            background: 'var(--bg-page)',
                            color: 'var(--accent)',
                            cursor: 'pointer',
                          }}
                          title={`Peek ${filePath}`}
                        >
                          <span>#{idx + 1}</span>
                          <span>{filePath.split('/').pop()}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Selected Module Inspector */}
            {selectedModule ? (
              <>
                <div
                  className="arch-inspector-header"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: '5px',
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        background: `${
                          ARCH_LAYER_META[selectedModule.layer]?.accentColor ??
                          '#3b82f6'
                        }22`,
                        color:
                          ARCH_LAYER_META[selectedModule.layer]?.accentColor ??
                          '#3b82f6',
                      }}
                    >
                      {selectedModule.layer} layer
                    </span>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: '5px',
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        background:
                          MASTERY_META[selectedModule.mastery ?? 'unexplored']
                            .bg,
                        color:
                          MASTERY_META[selectedModule.mastery ?? 'unexplored']
                            .color,
                      }}
                    >
                      {
                        MASTERY_META[selectedModule.mastery ?? 'unexplored']
                          .label
                      }
                    </span>
                  </div>

                  <h4
                    style={{
                      margin: 0,
                      fontSize: '1.05rem',
                      color: 'var(--text-strong)',
                    }}
                  >
                    {selectedModule.name}
                  </h4>

                  <code
                    style={{
                      fontSize: '0.76rem',
                      color: 'var(--text-muted)',
                    }}
                  >
                    {selectedModule.path}
                  </code>

                  <p
                    style={{
                      margin: '4px 0 0 0',
                      fontSize: '0.82rem',
                      color: 'var(--text-secondary)',
                      lineHeight: 1.45,
                    }}
                  >
                    {selectedModule.role}
                  </p>
                </div>

                {/* Primary Action Buttons */}
                <div
                  className="arch-inspector-actions"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}
                >
                  <button
                    type="button"
                    className="primary-button"
                    disabled={disabled}
                    onClick={() => handleTeachModule(selectedModule)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '7px',
                      width: '100%',
                      padding: '8px 12px',
                      fontSize: '0.82rem',
                      fontWeight: 600,
                    }}
                  >
                    <BookOpen size={15} />
                    <span>Teach Me This Module</span>
                  </button>

                  <button
                    type="button"
                    className="secondary-button"
                    disabled={disabled}
                    onClick={() => handleAnalyzeBlastRadius(selectedModule)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '7px',
                      width: '100%',
                      padding: '7px 12px',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                    }}
                  >
                    <Sparkles size={14} />
                    <span>Analyze Blast Radius in Chat</span>
                  </button>
                </div>

                {/* Blast Radius Summary Card */}
                {blastRadius && (
                  <div
                    className="arch-blast-card"
                    style={{
                      padding: '12px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-page)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span
                        style={{
                          fontSize: '0.76rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: 'var(--text-secondary)',
                          letterSpacing: '0.03em',
                        }}
                      >
                        Blast Radius & Impact
                      </span>
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          padding: '2px 7px',
                          borderRadius: '4px',
                          background:
                            blastRadius.riskLevel === 'high'
                              ? 'var(--danger-soft)'
                              : blastRadius.riskLevel === 'medium'
                              ? 'var(--warning-soft)'
                              : 'var(--success-soft)',
                          color:
                            blastRadius.riskLevel === 'high'
                              ? 'var(--danger)'
                              : blastRadius.riskLevel === 'medium'
                              ? 'var(--warning)'
                              : 'var(--success)',
                        }}
                      >
                        {blastRadius.riskLevel} risk ·{' '}
                        {blastRadius.affectedFilesCount} affected files
                      </span>
                    </div>

                    {/* Upstream Dependents */}
                    <div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '5px',
                          fontSize: '0.78rem',
                          fontWeight: 600,
                          color: 'var(--text-primary)',
                          marginBottom: '6px',
                        }}
                      >
                        <ArrowUpRight size={14} style={{ color: '#f59e0b' }} />
                        <span>
                          Upstream Dependents (
                          {blastRadius.directUpstream.length} direct,{' '}
                          {blastRadius.transitiveUpstream.length} transitive)
                        </span>
                      </div>
                      {blastRadius.directUpstream.length === 0 &&
                      blastRadius.transitiveUpstream.length === 0 ? (
                        <span
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)',
                          }}
                        >
                          No upstream callers depend on this module.
                        </span>
                      ) : (
                        <div
                          style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '5px',
                          }}
                        >
                          {blastRadius.directUpstream.map((callerId) => (
                            <button
                              key={callerId}
                              type="button"
                              onClick={() => setSelectedModuleId(callerId)}
                              style={{
                                padding: '3px 8px',
                                borderRadius: '6px',
                                border: '1px solid rgba(245, 158, 11, 0.45)',
                                background: 'rgba(245, 158, 11, 0.12)',
                                color: '#d97706',
                                fontSize: '0.73rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                              title="Direct upstream caller"
                            >
                              {moduleById.get(callerId)?.name ?? callerId}
                            </button>
                          ))}
                          {blastRadius.transitiveUpstream.map((callerId) => (
                            <button
                              key={callerId}
                              type="button"
                              onClick={() => setSelectedModuleId(callerId)}
                              style={{
                                padding: '3px 8px',
                                borderRadius: '6px',
                                border: '1px dashed rgba(234, 88, 12, 0.45)',
                                background: 'rgba(234, 88, 12, 0.08)',
                                color: '#ea580c',
                                fontSize: '0.73rem',
                                cursor: 'pointer',
                              }}
                              title="Transitive upstream caller"
                            >
                              {moduleById.get(callerId)?.name ?? callerId}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Downstream Dependencies */}
                    <div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '5px',
                          fontSize: '0.78rem',
                          fontWeight: 600,
                          color: 'var(--text-primary)',
                          marginBottom: '6px',
                        }}
                      >
                        <ArrowDownRight size={14} style={{ color: '#06b6d4' }} />
                        <span>
                          Downstream Imports (
                          {blastRadius.directDownstream.length} direct,{' '}
                          {blastRadius.transitiveDownstream.length} transitive)
                        </span>
                      </div>
                      {blastRadius.directDownstream.length === 0 &&
                      blastRadius.transitiveDownstream.length === 0 ? (
                        <span
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)',
                          }}
                        >
                          Leaf module (no internal module dependencies).
                        </span>
                      ) : (
                        <div
                          style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '5px',
                          }}
                        >
                          {blastRadius.directDownstream.map((depId) => (
                            <button
                              key={depId}
                              type="button"
                              onClick={() => setSelectedModuleId(depId)}
                              style={{
                                padding: '3px 8px',
                                borderRadius: '6px',
                                border: '1px solid rgba(6, 182, 212, 0.45)',
                                background: 'rgba(6, 182, 212, 0.12)',
                                color: '#0891b2',
                                fontSize: '0.73rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                              title="Direct downstream dependency"
                            >
                              {moduleById.get(depId)?.name ?? depId}
                            </button>
                          ))}
                          {blastRadius.transitiveDownstream.map((depId) => (
                            <button
                              key={depId}
                              type="button"
                              onClick={() => setSelectedModuleId(depId)}
                              style={{
                                padding: '3px 8px',
                                borderRadius: '6px',
                                border: '1px dashed rgba(99, 102, 241, 0.4)',
                                background: 'rgba(99, 102, 241, 0.08)',
                                color: '#6366f1',
                                fontSize: '0.73rem',
                                cursor: 'pointer',
                              }}
                              title="Transitive downstream dependency"
                            >
                              {moduleById.get(depId)?.name ?? depId}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Key Exported Symbols */}
                {selectedModule.keySymbols &&
                  selectedModule.keySymbols.length > 0 && (
                    <div
                      className="arch-symbols-section"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <Code2 size={13} />
                        Key Exported Symbols ({selectedModule.keySymbols.length})
                      </span>
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '5px',
                        }}
                      >
                        {selectedModule.keySymbols.map((sym) => (
                          <code
                            key={sym}
                            style={{
                              padding: '2px 7px',
                              borderRadius: '5px',
                              background: 'var(--bg-subtle)',
                              border: '1px solid var(--border-subtle)',
                              fontSize: '0.73rem',
                              color: 'var(--text-primary)',
                            }}
                          >
                            {sym}
                          </code>
                        ))}
                      </div>
                    </div>
                  )}

                {/* Files in Module */}
                <div
                  className="arch-files-section"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <FileCode2 size={13} />
                    Files in Module ({selectedModuleFiles.length})
                  </span>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '5px',
                    }}
                  >
                    {selectedModuleFiles.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        className="arch-file-row"
                        onClick={() =>
                          onOpenFilePeek({ kind: 'file', path: file.path })
                        }
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '8px',
                          padding: '7px 10px',
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--border-subtle)',
                          background: 'var(--bg-page)',
                          color: 'var(--text-primary)',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontSize: '0.76rem',
                        }}
                        title={`Inspect ${file.path} in Code Peek`}
                      >
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            color: 'var(--accent)',
                            fontWeight: 500,
                          }}
                        >
                          {file.path}
                        </span>
                        <span
                          style={{
                            fontSize: '0.7rem',
                            color: 'var(--text-muted)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {file.lines > 0 ? `${file.lines}L` : ''}
                          {file.exports && file.exports.length > 0
                            ? ` · ${file.exports.length} exp`
                            : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  height: '100%',
                  color: 'var(--text-muted)',
                  textAlign: 'center',
                  fontSize: '0.84rem',
                }}
              >
                <Compass size={24} />
                <span>
                  Click any module node on the canvas to inspect its blast
                  radius, key symbols, and source files.
                </span>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
