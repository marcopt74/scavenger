import {
  Check,
  FolderGit2,
  Lock,
  Plus,
  Settings2,
} from 'lucide-react';
import { ONBOARDING_STAGES } from '../../shared/types';
import type {
  CorePillarId,
  SessionPublicState,
  TopicMastery,
} from '../../shared/types';
import type { ThemeMode } from '../utils/theme';
import { ThemeToggleButton } from './ThemeToggleButton';

interface StageProgressBarProps {
  session: SessionPublicState;
  disabled: boolean;
  onSelectPillar: (pillarId: CorePillarId, title: string) => void;
  onOpenSettings: () => void;
  theme?: ThemeMode;
  onToggleTheme?: () => void;
  onResetSession: () => void;
}

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
  onOpenSettings,
  theme = 'light',
  onToggleTheme,
  onResetSession,
}: StageProgressBarProps) {
  const learning = session.learning;
  const pillarTopics = learning.topics.filter((t) => t.kind === 'pillar');

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
        {onToggleTheme && (
          <ThemeToggleButton theme={theme} onToggle={onToggleTheme} />
        )}

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
