import {
  Activity,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  FolderGit2,
  FolderOpen,
  History,
  Loader2,
  Lock,
  MessageSquare,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { ONBOARDING_STAGES } from '../../shared/types';
import type {
  HealthInfo,
  ProviderSelection,
  RepoProgressSummary,
  ScanPhase,
  SessionSummary,
  TopicMastery,
} from '../../shared/types';
import { FileExplorerModal } from './FileExplorerModal';
import { formatRelativeTime } from './SessionsProgressModal';
import { ThemeToggleButton } from './ThemeToggleButton';
import type { ThemeMode } from '../utils/theme';

export interface ScanProgressState {
  phase: ScanPhase;
  message: string;
  percent: number;
  filesProcessed?: number;
  totalFiles?: number;
}

interface RepoWelcomeProps {
  health: HealthInfo | null;
  provider: ProviderSelection;
  loading: boolean;
  restoringSession?: boolean;
  scanProgress?: ScanProgressState | null;
  error: string | null;
  sessions?: SessionSummary[];
  repoProgress?: RepoProgressSummary[];
  onStartSession: (repoPath: string, options?: { startFresh?: boolean }) => void;
  onResumeSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onOpenProgressModal?: () => void;
  onOpenSettings: () => void;
  theme?: ThemeMode;
  onToggleTheme?: () => void;
}

const MASTERY_LABELS: Record<TopicMastery, string> = {
  unexplored: 'New',
  introduced: 'Introduced',
  developing: 'Developing',
  solid: 'Solid',
};

const SCAN_STEPS: Array<{ id: ScanPhase; label: string }> = [
  { id: 'recon', label: 'Root reconnaissance & git HEAD inspection' },
  { id: 'indexing', label: 'Indexing files, exported symbols & imports' },
  { id: 'dependencies', label: 'Mapping cross-module dependencies & flows' },
  { id: 'synthesis', label: 'Synthesizing architecture Knowledge Map' },
  { id: 'saving', label: 'Caching Knowledge Map locally' },
];

export function RepoWelcome({
  health,
  provider,
  loading,
  restoringSession = false,
  scanProgress,
  error,
  sessions = [],
  repoProgress = [],
  onStartSession,
  onResumeSession,
  onDeleteSession,
  onOpenProgressModal,
  onOpenSettings,
  theme = 'light',
  onToggleTheme,
}: RepoWelcomeProps) {
  const [repoPath, setRepoPath] = useState('');
  const [explorerOpen, setExplorerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!repoPath.trim() || loading) return;
    onStartSession(repoPath.trim());
  }

  if (restoringSession) {
    return (
      <div className="welcome-container">
        {onToggleTheme && (
          <div className="welcome-top-actions">
            <ThemeToggleButton theme={theme} onToggle={onToggleTheme} />
          </div>
        )}
        <div className="welcome-inner">
          <div className="scan-progress-card" role="status" aria-live="polite">
            <div className="scan-progress-header">
              <div className="scan-progress-title-row">
                <Loader2 size={16} className="spin-icon" />
                <span className="scan-progress-title">
                  Restoring your active onboarding session…
                </span>
              </div>
            </div>
            <div className="scan-progress-message">
              Reloading conversation history, calibrated depth, and Knowledge Map progress.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="welcome-container">
      {onToggleTheme && (
        <div className="welcome-top-actions">
          <ThemeToggleButton theme={theme} onToggle={onToggleTheme} />
        </div>
      )}
      <div className="welcome-inner">
        <div className="welcome-badge">
          <Sparkles size={14} />
          <span>Senior Architect · Repository Onboarding</span>
        </div>

        <h1 className="welcome-title">Understand any codebase, from the root up.</h1>

        <p className="welcome-subtitle">
          Point Scavenger at a local repository. Our scanner agent builds a pre-onboarding Knowledge
          Map of modules, symbols, and dependencies first, then walks you through purpose,
          architecture, core flows, and git evolution with live diagrams.
        </p>

        <form className="repo-form" onSubmit={handleSubmit}>
          <FolderGit2 size={18} color="#5f6368" className="repo-form-icon" />
          <input
            ref={inputRef}
            type="text"
            className="repo-input"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="/path/to/local/repository"
            disabled={loading}
            autoFocus
          />
          <button
            type="button"
            className="repo-browse-btn"
            disabled={loading}
            onClick={() => setExplorerOpen(true)}
            title="Browse folders on disk"
            aria-label="Browse folders on disk"
          >
            <FolderOpen size={15} />
            <span>Browse</span>
          </button>
          <button
            type="submit"
            className="primary-pill-btn"
            disabled={loading || !repoPath.trim()}
          >
            <span>{loading ? 'Scanning Repo…' : 'Start Onboarding'}</span>
            <ArrowRight size={15} />
          </button>
        </form>

        {loading && scanProgress && (
          <div className="scan-progress-card" role="status" aria-live="polite">
            <div className="scan-progress-header">
              <div className="scan-progress-title-row">
                <Loader2 size={15} className="spin-icon" />
                <span className="scan-progress-title">
                  Building Pre-Onboarding Repository Knowledge Map
                </span>
              </div>
              <span className="scan-progress-percent">{Math.min(100, Math.max(5, scanProgress.percent))}%</span>
            </div>
            <div className="scan-progress-bar-track">
              <div
                className="scan-progress-bar-fill"
                style={{ width: `${Math.min(100, Math.max(5, scanProgress.percent))}%` }}
              />
            </div>
            <div className="scan-progress-message">{scanProgress.message}</div>
            <div className="scan-steps-row">
              {SCAN_STEPS.map((step, idx) => {
                const currentIdx = SCAN_STEPS.findIndex(
                  (s) =>
                    s.id ===
                    (scanProgress.phase === 'incremental-diff' ? 'indexing' : scanProgress.phase)
                );
                const isDone = currentIdx > idx || scanProgress.percent >= 100;
                const isCurrent = currentIdx === idx && scanProgress.percent < 100;
                return (
                  <div
                    key={step.id}
                    className={`scan-step-chip ${isDone ? 'done' : isCurrent ? 'active' : ''}`}
                  >
                    {isDone ? <CheckCircle2 size={12} /> : <span className="scan-step-dot" />}
                    <span>{step.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="welcome-quick-row">
          {health?.suggestedRepoPath && (
            <button
              type="button"
              className="quick-chip"
              disabled={loading}
              onClick={() => {
                setRepoPath(health.suggestedRepoPath);
                onStartSession(health.suggestedRepoPath);
              }}
            >
              <FolderOpen size={13} />
              <span>Inspect current workspace</span>
            </button>
          )}

          <button type="button" className="quick-chip" onClick={onOpenSettings}>
            <Settings2 size={13} />
            <span>
              Provider: <strong>{provider.provider}</strong>
              {provider.model ? ` (${provider.model})` : ''}
              {provider.provider === 'demo' &&
              health &&
              !health.configuredProviders.copilot &&
              !health.configuredProviders.google &&
              !health.configuredProviders.openai &&
              !health.configuredProviders.anthropic &&
              !health.configuredProviders['openai-compatible']
                ? ' · Configure API keys'
                : ''}
            </span>
          </button>

          <span className="quick-chip" style={{ cursor: 'default' }}>
            <Lock size={13} className="readonly-icon" />
            <span>Strict read-only enforced</span>
          </span>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {repoProgress.length > 0 && (
          <section className="welcome-sessions-section" aria-label="Cross-session progress and recent sessions">
            <div className="welcome-sessions-header">
              <div className="welcome-sessions-title-group">
                <Activity size={15} className="readonly-icon" />
                <h2 className="welcome-sessions-title">
                  Continue Onboarding · Cross-Session Progress
                </h2>
              </div>
              {onOpenProgressModal && (
                <button
                  type="button"
                  className="chip-button"
                  onClick={onOpenProgressModal}
                >
                  <History size={13} />
                  <span>All Sessions ({sessions.length})</span>
                </button>
              )}
            </div>

            <div className="welcome-repo-progress-grid">
              {repoProgress.slice(0, 3).map((repo) => (
                <div key={repo.repoPath} className="repo-progress-card compact">
                  <div className="repo-progress-card-top">
                    <div className="repo-progress-title-group">
                      <div className="repo-progress-name-row">
                        <FolderGit2 size={15} className="readonly-icon" />
                        <span className="repo-progress-name">{repo.repoName}</span>
                        <span className="session-badge">
                          {repo.sessionCount} {repo.sessionCount === 1 ? 'session' : 'sessions'}
                        </span>
                        {repo.inferredLevel !== 'uncalibrated' && (
                          <span className="session-badge level">
                            {repo.inferredLevel}
                          </span>
                        )}
                      </div>
                      <span className="repo-progress-path" title={repo.repoPath}>
                        {repo.repoPath}
                      </span>
                    </div>

                    <div className="repo-progress-pct-box">
                      <span className="repo-progress-pct-value">{repo.progressPercent}%</span>
                      <span className="repo-progress-pct-label">Mastery</span>
                    </div>
                  </div>

                  <div className="repo-progress-bar-track">
                    <div
                      className="repo-progress-bar-fill"
                      style={{ width: `${Math.max(4, repo.progressPercent)}%` }}
                    />
                  </div>

                  <div className="repo-progress-pillars">
                    {ONBOARDING_STAGES.map((stage) => {
                      const mastery = repo.pillarMasteries[stage.pillarId] ?? 'unexplored';
                      return (
                        <div
                          key={stage.pillarId}
                          className={`repo-pillar-chip mastery-${mastery}`}
                          title={`${stage.title}: ${MASTERY_LABELS[mastery]}`}
                        >
                          <span className={`mastery-indicator mastery-${mastery}`}>
                            {mastery === 'solid' ? <Check size={9} strokeWidth={3} /> : null}
                          </span>
                          <span className="repo-pillar-chip-name">{stage.shortLabel}</span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="repo-progress-card-footer">
                    <div className="repo-progress-stats">
                      <span>
                        <strong>{repo.exploredTopicsCount}</strong>/{repo.totalTopicsCount} topics
                      </span>
                      <span>·</span>
                      <span>{repo.observedFilesCount} files</span>
                      <span>·</span>
                      <span>Updated {formatRelativeTime(repo.lastUpdatedAt)}</span>
                    </div>

                    <div className="repo-progress-actions">
                      {onResumeSession && (
                        <button
                          type="button"
                          className="primary-pill-btn compact"
                          disabled={loading}
                          onClick={() => onResumeSession(repo.lastSessionId)}
                        >
                          <Play size={12} />
                          <span>Resume Session</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="chip-button"
                        disabled={loading}
                        title="Start a new session carrying over your prior topic mastery and calibration"
                        onClick={() => onStartSession(repo.repoPath, { startFresh: false })}
                      >
                        <Plus size={12} />
                        <span>New Session</span>
                      </button>
                      <button
                        type="button"
                        className="chip-button"
                        disabled={loading}
                        title="Start a fresh onboarding session from scratch"
                        onClick={() => onStartSession(repo.repoPath, { startFresh: true })}
                      >
                        <RotateCcw size={12} />
                        <span>Start Fresh</span>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {sessions.length > 1 && (
              <div className="welcome-recent-sessions">
                <div className="welcome-recent-sessions-label">Recent Sessions</div>
                <div className="welcome-recent-sessions-list">
                  {sessions.slice(0, 4).map((sess) => {
                    const stageMeta = ONBOARDING_STAGES[sess.currentStage] ?? ONBOARDING_STAGES[0];
                    return (
                      <div key={sess.id} className="welcome-session-row">
                        <div className="welcome-session-info">
                          <span className="welcome-session-repo">{sess.repoName}</span>
                          <span className="session-badge">
                            Stage {sess.currentStage}: {stageMeta.shortLabel}
                          </span>
                          <span className="welcome-session-topic">{sess.activeTopicTitle}</span>
                        </div>
                        <div className="welcome-session-meta">
                          <span>
                            <MessageSquare size={11} />
                            {sess.messageCount}
                          </span>
                          <span>
                            <Clock size={11} />
                            {formatRelativeTime(sess.updatedAt)}
                          </span>
                          {onResumeSession && (
                            <button
                              type="button"
                              className="chip-button"
                              disabled={loading}
                              onClick={() => onResumeSession(sess.id)}
                            >
                              <span>Resume</span>
                              <ArrowRight size={11} />
                            </button>
                          )}
                          {onDeleteSession && (
                            <button
                              type="button"
                              className="icon-button danger-hover"
                              disabled={loading}
                              title="Delete session"
                              aria-label={`Delete session ${sess.id}`}
                              onClick={() => onDeleteSession(sess.id)}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        )}

        <div className="welcome-guarantees">
          <div className="guarantee-card">
            <h3 className="guarantee-title">Staged Discovery (0 → 4)</h3>
            <p className="guarantee-text">
              Root recon & calibration first, then purpose, architecture, core flows, and git history.
            </p>
          </div>
          <div className="guarantee-card">
            <h3 className="guarantee-title">Read-Only Guardrails</h3>
            <p className="guarantee-text">
              Backend path confinement and lock-free read-only git allowlists ensure zero repo mutations.
            </p>
          </div>
          <div className="guarantee-card">
            <h3 className="guarantee-title">Visual-First Explanations</h3>
            <p className="guarantee-text">
              Architecture and flow diagrams render inline as crisp interactive SVGs—not raw syntax.
            </p>
          </div>
        </div>
      </div>

      {explorerOpen && (
        <FileExplorerModal
          initialPath={repoPath.trim() || undefined}
          onSelect={(selectedPath) => {
            setRepoPath(selectedPath);
            setExplorerOpen(false);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          onClose={() => setExplorerOpen(false)}
        />
      )}
    </div>
  );
}
