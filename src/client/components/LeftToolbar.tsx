import {
  Activity,
  Check,
  ChevronRight,
  Database,
  Map as MapIcon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  LearningTopic,
  RepoProgressSummary,
  SessionPublicState,
  TopicMastery,
  UserLevel,
} from '../../shared/types';

export interface LeftToolbarProps {
  session: SessionPublicState;
  disabled: boolean;
  refreshingKnowledge?: boolean;
  currentRepoProgress?: RepoProgressSummary;
  totalSessionsCount?: number;
  onSelectTopic: (topic: LearningTopic) => void;
  onSelectModule?: (moduleId: string) => void;
  onRefreshKnowledge?: () => void;
  onChangeLevel: (level: UserLevel) => void;
  onOpenProgressModal?: () => void;
}

export const LEVEL_OPTIONS: Array<{
  value: UserLevel;
  label: string;
  shortBadge: string;
  desc: string;
}> = [
  {
    value: 'uncalibrated',
    label: 'Auto',
    shortBadge: 'Auto',
    desc: 'Adapt automatically from your questions & replies',
  },
  {
    value: 'foundational',
    label: 'Foundational',
    shortBadge: 'Fnd',
    desc: 'Mental models, plain terms, gentle code refs',
  },
  {
    value: 'intermediate',
    label: 'Intermediate',
    shortBadge: 'Int',
    desc: 'Balanced architecture, contracts & entry points',
  },
  {
    value: 'advanced',
    label: 'Advanced',
    shortBadge: 'Adv',
    desc: 'Staff-level trade-offs, invariants & internals',
  },
];

const MASTERY_LABELS: Record<TopicMastery, string> = {
  unexplored: 'New',
  introduced: 'Introduced',
  developing: 'Developing',
  solid: 'Solid',
};

export function formatDepthLabel(level: UserLevel): string {
  const found = LEVEL_OPTIONS.find((opt) => opt.value === level);
  return found ? found.label : 'Auto';
}

export function LeftToolbar({
  session,
  disabled,
  refreshingKnowledge = false,
  currentRepoProgress,
  totalSessionsCount = 1,
  onSelectTopic,
  onSelectModule,
  onRefreshKnowledge,
  onChangeLevel,
  onOpenProgressModal,
}: LeftToolbarProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [levelOpen, setLevelOpen] = useState(false);

  const hoverTimeoutRef = useRef<number | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const levelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      const target = e.target as Node;
      if (mapRef.current && !mapRef.current.contains(target)) {
        setMapOpen(false);
      }
      if (levelRef.current && !levelRef.current.contains(target)) {
        setLevelOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current !== null) {
        window.clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  function handleMouseEnter() {
    if (hoverTimeoutRef.current !== null) {
      window.clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setIsHovered(true);
  }

  function handleMouseLeave() {
    if (hoverTimeoutRef.current !== null) {
      window.clearTimeout(hoverTimeoutRef.current);
    }
    hoverTimeoutRef.current = window.setTimeout(() => {
      setIsHovered(false);
    }, 150);
  }

  const isExpanded = isHovered || isPinned || mapOpen || levelOpen;

  const learning = session.learning;
  const pillarTopics = learning.topics.filter((t) => t.kind === 'pillar');
  const customTopics = learning.topics.filter((t) => t.kind === 'custom');
  const exploredCount = learning.topics.filter((t) => t.mastery !== 'unexplored').length;
  const kb = session.knowledgeStatus;
  const kbModules = kb?.modules ?? [];

  const currentLevel = session.diagnostic.inferredLevel;
  const currentLevelOption =
    LEVEL_OPTIONS.find((opt) => opt.value === currentLevel) ?? LEVEL_OPTIONS[0];
  const progressValueText = currentRepoProgress
    ? `${currentRepoProgress.progressPercent}%`
    : `${exploredCount}/${learning.topics.length}`;

  return (
    <aside
      className={`left-toolbar ${isExpanded ? 'is-expanded' : 'is-collapsed'}`}
      aria-label="Session tools and calibration"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="left-toolbar-items">
        {onRefreshKnowledge && (
          <button
            type="button"
            className={`left-toolbar-btn kb-refresh-chip ${kb?.isStale ? 'is-stale' : ''}`}
            disabled={disabled || refreshingKnowledge}
            onClick={onRefreshKnowledge}
            title={
              kb?.stats
                ? `Repo Knowledge Base: ${kb.stats.indexedFiles} files, ${kb.stats.totalModules} modules, ${kb.stats.totalSymbols} symbols${kb.headCommit ? ` @ ${kb.headCommit.slice(0, 7)}` : ''} — Click to refresh`
                : 'Refresh Repository Knowledge Base'
            }
          >
            <span className="left-toolbar-icon-wrap">
              <RefreshCw size={16} className={refreshingKnowledge ? 'spin-icon' : ''} />
              {kb?.isStale && <span className="left-toolbar-status-dot is-stale" />}
            </span>
            <span className="left-toolbar-copy">
              <span className="left-toolbar-label">
                {refreshingKnowledge
                  ? 'Refreshing KB…'
                  : kb?.stats
                    ? `KB · ${kb.stats.totalModules} mod`
                    : 'Refresh KB'}
              </span>
              <span className="left-toolbar-sub">
                {kb?.stats ? `${kb.stats.indexedFiles} files indexed` : 'Re-scan repo'}
              </span>
            </span>
          </button>
        )}

        <div className="left-toolbar-menu-wrap" ref={mapRef}>
          <button
            type="button"
            className={`left-toolbar-btn ${mapOpen ? 'is-active' : ''}`}
            onClick={() => {
              setMapOpen((v) => !v);
              setLevelOpen(false);
            }}
            title="View your Knowledge Map & scanned repository modules"
            aria-expanded={mapOpen}
          >
            <span className="left-toolbar-icon-wrap">
              <MapIcon size={16} />
              <span className="left-toolbar-mini-badge">{exploredCount}</span>
            </span>
            <span className="left-toolbar-copy">
              <span className="left-toolbar-label">Map · {exploredCount}</span>
              <span className="left-toolbar-sub">
                {learning.topics.length} topics{kbModules.length > 0 ? ` · ${kbModules.length} mod` : ''}
              </span>
            </span>
            <ChevronRight size={14} className="left-toolbar-chevron" />
          </button>

          {mapOpen && (
            <div className="knowledge-popover left-toolbar-popover">
              <div className="knowledge-popover-header">
                <div className="level-popover-title" style={{ padding: 0 }}>
                  Knowledge Map
                </div>
                <span className="knowledge-active-label">
                  Active: <strong>{learning.activeTopicTitle}</strong>
                </span>
                {learning.lastAssessmentSummary && (
                  <p className="knowledge-summary-note">{learning.lastAssessmentSummary}</p>
                )}
              </div>

              {kb?.stats && (
                <div className="kb-popover-banner">
                  <div className="kb-popover-top">
                    <span className="kb-popover-badge">
                      <Database size={11} />
                      <span>
                        Repo Index · {kb.stats.indexedFiles} files · {kb.stats.totalSymbols} symbols
                      </span>
                    </span>
                    {onRefreshKnowledge && (
                      <button
                        type="button"
                        className="kb-inline-refresh-btn"
                        disabled={disabled || refreshingKnowledge}
                        onClick={() => onRefreshKnowledge()}
                        title="Re-scan repository and refresh Knowledge Base"
                      >
                        <RefreshCw size={11} className={refreshingKnowledge ? 'spin-icon' : ''} />
                        <span>{refreshingKnowledge ? 'Scanning…' : 'Refresh'}</span>
                      </button>
                    )}
                  </div>
                  <div className="kb-popover-meta">
                    {kb.headCommit ? `HEAD @ ${kb.headCommit.slice(0, 7)}` : 'Working tree'}
                    {kb.lastRefreshTrigger === 'git-pull-auto'
                      ? ' · Auto-updated on git pull'
                      : kb.lastRefreshTrigger === 'cached'
                        ? ' · Cached'
                        : ' · Fresh scan'}
                  </div>
                </div>
              )}

              <div className="knowledge-section">
                <div className="knowledge-section-label">Core Repository Pillars</div>
                {pillarTopics.map((topic) => (
                  <button
                    key={topic.id}
                    type="button"
                    disabled={disabled}
                    className={`topic-row ${topic.id === learning.activeTopicId ? 'active' : ''}`}
                    onClick={() => {
                      onSelectTopic(topic);
                      setMapOpen(false);
                    }}
                  >
                    <span className="topic-row-title">{topic.title}</span>
                    <span className={`mastery-pill mastery-${topic.mastery}`}>
                      {MASTERY_LABELS[topic.mastery]}
                    </span>
                  </button>
                ))}
              </div>

              <div className="knowledge-section">
                <div className="knowledge-section-label">
                  Custom Topics ({customTopics.length})
                </div>
                {customTopics.length === 0 ? (
                  <p className="knowledge-empty">
                    Ask to learn any module, file, or concept and it will appear here.
                  </p>
                ) : (
                  customTopics.map((topic) => (
                    <button
                      key={topic.id}
                      type="button"
                      disabled={disabled}
                      className={`topic-row ${topic.id === learning.activeTopicId ? 'active' : ''}`}
                      onClick={() => {
                        onSelectTopic(topic);
                        setMapOpen(false);
                      }}
                    >
                      <span className="topic-row-title">{topic.title}</span>
                      <span className={`mastery-pill mastery-${topic.mastery}`}>
                        {MASTERY_LABELS[topic.mastery]}
                      </span>
                    </button>
                  ))
                )}
              </div>

              {kbModules.length > 0 && (
                <div className="knowledge-section">
                  <div className="knowledge-section-label">
                    Scanned Repo Modules ({kbModules.length})
                  </div>
                  {kbModules.slice(0, 10).map((mod) => (
                    <button
                      key={mod.id}
                      type="button"
                      disabled={disabled}
                      className="topic-row"
                      title={mod.role}
                      onClick={() => {
                        onSelectModule?.(mod.id);
                        setMapOpen(false);
                      }}
                    >
                      <span className="topic-row-title">{mod.id}</span>
                      <span className="mastery-pill mastery-unexplored">
                        {mod.layer} · {mod.fileCount}f
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {onOpenProgressModal && (
          <button
            type="button"
            className="left-toolbar-btn"
            onClick={onOpenProgressModal}
            title="Monitor progress across sessions, switch sessions, or resume previous onboarding"
          >
            <span className="left-toolbar-icon-wrap">
              <Activity size={16} />
              <span className="left-toolbar-mini-badge">{progressValueText}</span>
            </span>
            <span className="left-toolbar-copy">
              <span className="left-toolbar-label">
                Progress · {progressValueText}
              </span>
              <span className="left-toolbar-sub">
                {totalSessionsCount > 1
                  ? `${totalSessionsCount} sessions recorded`
                  : 'Sessions & mastery'}
              </span>
            </span>
          </button>
        )}

        <div className="left-toolbar-menu-wrap" ref={levelRef}>
          <button
            type="button"
            className={`left-toolbar-btn ${levelOpen ? 'is-active' : ''}`}
            onClick={() => {
              setLevelOpen((v) => !v);
              setMapOpen(false);
            }}
            title="Recalibrate explanation depth"
            aria-expanded={levelOpen}
          >
            <span className="left-toolbar-icon-wrap">
              <SlidersHorizontal size={16} />
              <span className="left-toolbar-mini-badge">{currentLevelOption.shortBadge}</span>
            </span>
            <span className="left-toolbar-copy">
              <span className="left-toolbar-label">
                Depth: {currentLevelOption.label}
              </span>
              <span className="left-toolbar-sub">Explanation calibration</span>
            </span>
            <ChevronRight size={14} className="left-toolbar-chevron" />
          </button>

          {levelOpen && (
            <div className="level-popover left-toolbar-popover">
              <div className="level-popover-title">Explanation Depth</div>
              {LEVEL_OPTIONS.map((opt) => {
                const isSelected = currentLevel === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`level-option ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      onChangeLevel(opt.value);
                      setLevelOpen(false);
                    }}
                  >
                    <div className="level-option-top">
                      <span className="level-option-name">{opt.label}</span>
                      {isSelected && <Check size={13} className="level-option-check" />}
                    </div>
                    <span className="level-option-desc">{opt.desc}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="left-toolbar-footer">
        <button
          type="button"
          className={`left-toolbar-pin-btn ${isPinned ? 'is-pinned' : ''}`}
          onClick={() => setIsPinned((v) => !v)}
          title={isPinned ? 'Unpin toolbar (auto-collapse on mouse leave)' : 'Pin toolbar open'}
          aria-label={isPinned ? 'Unpin toolbar' : 'Pin toolbar open'}
        >
          <span className="left-toolbar-icon-wrap">
            {isPinned ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </span>
          <span className="left-toolbar-copy">
            <span className="left-toolbar-sub">
              {isPinned ? 'Pinned open' : 'Auto-collapse'}
            </span>
          </span>
        </button>
      </div>
    </aside>
  );
}
