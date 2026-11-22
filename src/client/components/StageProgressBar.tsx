import { Check, ChevronDown, FolderGit2, Lock, Plus, Settings2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ONBOARDING_STAGES } from '../../shared/types';
import type { SessionPublicState, UserLevel } from '../../shared/types';

interface StageProgressBarProps {
  session: SessionPublicState;
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

export function StageProgressBar({
  session,
  onChangeLevel,
  onOpenSettings,
  onResetSession,
}: StageProgressBarProps) {
  const [levelOpen, setLevelOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setLevelOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

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

      <nav className="stage-rail" aria-label="Onboarding stages">
        {ONBOARDING_STAGES.map((stage) => {
          const isActive = session.currentStage === stage.id;
          const isCompleted = session.completedStages.includes(stage.id);
          return (
            <div
              key={stage.id}
              className={`stage-step ${isActive ? 'active' : isCompleted ? 'completed' : ''}`}
              title={`Stage ${stage.id}: ${stage.title} — ${stage.description}`}
            >
              <span className="stage-step-num">
                {isCompleted && !isActive ? <Check size={10} strokeWidth={3} /> : stage.id}
              </span>
              <span>{stage.shortLabel}</span>
            </div>
          );
        })}
      </nav>

      <div className="topbar-right">
        <div className="level-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="chip-button"
            onClick={() => setLevelOpen((v) => !v)}
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
