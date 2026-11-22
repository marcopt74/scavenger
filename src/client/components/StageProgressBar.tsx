import { Check, ChevronDown, FolderGit2, Lock, Map as MapIcon, Plus, Settings2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ONBOARDING_STAGES } from '../../shared/types';
import type {
  CorePillarId,
  LearningTopic,
  SessionPublicState,
  TopicMastery,
  UserLevel,
} from '../../shared/types';

interface StageProgressBarProps {
  session: SessionPublicState;
  disabled: boolean;
  onSelectPillar: (pillarId: CorePillarId, title: string) => void;
  onSelectTopic: (topic: LearningTopic) => void;
  onChangeLevel: (level: UserLevel) => void;
  onOpenSettings: () => void;
  onResetSession: () => void;
}

const LEVEL_OPTIONS: Array<{ value: UserLevel; label: string; desc: string }> = [
  {
    value: 'foundational',
    label: 'Foundational',
    desc: 'Mental models, plain terms, gentle code refs',
  },
  {
    value: 'intermediate',
    label: 'Intermediate',
    desc: 'Balanced architecture, contracts & entry points',
  },
  {
    value: 'advanced',
    label: 'Advanced',
    desc: 'Staff-level trade-offs, invariants & internals',
  },
];

const MASTERY_LABELS: Record<TopicMastery, string> = {
  unexplored: 'New',
  introduced: 'Introduced',
  developing: 'Developing',
  solid: 'Solid',
};

export function StageProgressBar({
  session,
  disabled,
  onSelectPillar,
  onSelectTopic,
  onChangeLevel,
  onOpenSettings,
  onResetSession,
}: StageProgressBarProps) {
  const [levelOpen, setLevelOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const levelRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      const target = e.target as Node;
      if (levelRef.current && !levelRef.current.contains(target)) {
        setLevelOpen(false);
      }
      if (mapRef.current && !mapRef.current.contains(target)) {
        setMapOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const learning = session.learning;
  const pillarTopics = learning.topics.filter((t) => t.kind === 'pillar');
  const customTopics = learning.topics.filter((t) => t.kind === 'custom');
  const exploredCount = learning.topics.filter((t) => t.mastery !== 'unexplored').length;

  const currentLevelLabel =
    session.diagnostic.inferredLevel === 'uncalibrated'
      ? 'Depth: Auto'
      : `Depth: ${capitalize(session.diagnostic.inferredLevel)}`;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand-mark">
          <span className="brand-dot" />
          <span>Scavenger</span>
        </div>

        <div className="repo-pill" title={`${session.repoPath} (Read-only enforced)`}>
          <Lock size={12} className="readonly-icon" />
          <FolderGit2 size={13} />
          <span className="repo-pill-name">{session.repoName}</span>
        </div>
      </div>

      <nav className="stage-rail" aria-label="Repository learning pillars">
        {ONBOARDING_STAGES.map((stage) => {
          const topic = pillarTopics.find((t) => t.pillarId === stage.pillarId);
          const mastery: TopicMastery = topic?.mastery ?? 'unexplored';
          const isActive = learning.activeTopicId === `pillar:${stage.pillarId}`;

          return (
            <button
              key={stage.pillarId}
              type="button"
              disabled={disabled}
              className={`stage-step pillar-btn mastery-${mastery} ${isActive ? 'active' : ''}`}
              title={`${stage.title} (${MASTERY_LABELS[mastery]}) — click to explore or revisit`}
              onClick={() => onSelectPillar(stage.pillarId, stage.title)}
            >
              <span className={`mastery-indicator mastery-${mastery}`}>
                {mastery === 'solid' ? <Check size={10} strokeWidth={3} /> : null}
              </span>
              <span>{stage.shortLabel}</span>
            </button>
          );
        })}
      </nav>

      <div className="topbar-right">
        <div className="level-menu-wrap" ref={mapRef}>
          <button
            type="button"
            className="chip-button"
            onClick={() => {
              setMapOpen((v) => !v);
              setLevelOpen(false);
            }}
            title="View your Knowledge Map & custom topics"
          >
            <MapIcon size={13} />
            <span>Map · {exploredCount}</span>
            <ChevronDown size={13} />
          </button>

          {mapOpen && (
            <div className="knowledge-popover">
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
            </div>
          )}
        </div>

        <div className="level-menu-wrap" ref={levelRef}>
          <button
            type="button"
            className="chip-button"
            onClick={() => {
              setLevelOpen((v) => !v);
              setMapOpen(false);
            }}
            title="Recalibrate explanation depth"
          >
            <span>{currentLevelLabel}</span>
            <ChevronDown size={13} />
          </button>

          {levelOpen && (
            <div className="level-popover">
              <div className="level-popover-title">Explanation Depth</div>
              {LEVEL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`level-option ${session.diagnostic.inferredLevel === opt.value ? 'selected' : ''}`}
                  onClick={() => {
                    onChangeLevel(opt.value);
                    setLevelOpen(false);
                  }}
                >
                  <span className="level-option-name">{opt.label}</span>
                  <span className="level-option-desc">{opt.desc}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className="icon-button"
          onClick={onOpenSettings}
          title="Provider & safety settings"
          aria-label="Provider & safety settings"
        >
          <Settings2 size={17} />
        </button>

        <button
          type="button"
          className="icon-button"
          onClick={onResetSession}
          title="Onboard another repository"
          aria-label="Onboard another repository"
        >
          <Plus size={18} />
        </button>
      </div>
    </header>
  );
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
