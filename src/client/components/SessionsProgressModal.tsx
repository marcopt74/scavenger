import {
  Activity,
  ArrowRight,
  Check,
  Clock,
  FolderGit2,
  History,
  Layers,
  MessageSquare,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { ONBOARDING_STAGES } from '../../shared/types';
import type {
  RepoProgressSummary,
  SessionSummary,
  TopicMastery,
} from '../../shared/types';

interface SessionsProgressModalProps {
  activeSessionId?: string;
  activeRepoPath?: string;
  sessions: SessionSummary[];
  repoProgress: RepoProgressSummary[];
  loading?: boolean;
  onResumeSession: (sessionId: string) => void;
  onStartRepoSession: (repoPath: string, options?: { startFresh?: boolean }) => void;
  onDeleteSession: (sessionId: string) => void;
  onClose: () => void;
}

const MASTERY_LABELS: Record<TopicMastery, string> = {
  unexplored: 'New',
  introduced: 'Introduced',
  developing: 'Developing',
  solid: 'Solid',
};

export function SessionsProgressModal({
  activeSessionId,
  activeRepoPath,
  sessions,
  repoProgress,
  loading = false,
  onResumeSession,
  onStartRepoSession,
  onDeleteSession,
  onClose,
}: SessionsProgressModalProps) {
  const [tab, setTab] = useState<'progress' | 'sessions'>('progress');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const backdropMouseDownRef = useRef(false);

  const orderedRepoProgress = [...repoProgress].sort((a, b) => {
    if (activeRepoPath) {
      if (a.repoPath === activeRepoPath && b.repoPath !== activeRepoPath) return -1;
      if (b.repoPath === activeRepoPath && a.repoPath !== activeRepoPath) return 1;
    }
    return b.lastUpdatedAt.localeCompare(a.lastUpdatedAt);
  });

  const filteredSessions =
    repoFilter === 'all'
      ? sessions
      : sessions.filter((s) => s.repoPath === repoFilter);

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
        className="modal-panel sessions-progress-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sessions-progress-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="settings-header-copy">
            <h3 id="sessions-progress-modal-title">Sessions & Cross-Session Progress</h3>
            <span className="settings-header-sub">
              Monitor cumulative repository mastery across sessions, resume where you left off, or start a new session
            </span>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close sessions and progress modal"
          >
            <X size={18} />
          </button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="Progress sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'progress'}
            className={`settings-tab-btn ${tab === 'progress' ? 'active' : ''}`}
            onClick={() => setTab('progress')}
          >
            <Activity size={14} />
            <span>Repository Progress ({repoProgress.length})</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sessions'}
            className={`settings-tab-btn ${tab === 'sessions' ? 'active' : ''}`}
            onClick={() => setTab('sessions')}
          >
            <History size={14} />
            <span>All Sessions ({sessions.length})</span>
          </button>
        </div>

        <div className="modal-body sessions-modal-body">
          {tab === 'progress' && (
            <>
              {orderedRepoProgress.length === 0 ? (
                <div className="sessions-empty-state">
                  <Layers size={24} className="explorer-empty-icon" />
                  <p>No onboarding sessions recorded yet. Start onboarding a repository to track progress.</p>
                </div>
              ) : (
                <div className="repo-progress-list">
                  {orderedRepoProgress.map((repo) => {
                    const customTopics = repo.topics.filter((t) => t.kind === 'custom');
                    const isCurrentRepo = activeRepoPath === repo.repoPath;
                    const isLatestActive = activeSessionId === repo.lastSessionId;

                    return (
                      <div
                        key={repo.repoPath}
                        className={`repo-progress-card ${isCurrentRepo ? 'is-current-repo' : ''}`}
                      >
                        <div className="repo-progress-card-top">
                          <div className="repo-progress-title-group">
                            <div className="repo-progress-name-row">
                              <FolderGit2 size={16} className="readonly-icon" />
                              <span className="repo-progress-name">{repo.repoName}</span>
                              {isCurrentRepo && (
                                <span className="session-badge active">Active Repo</span>
                              )}
                              <span className="session-badge">
                                {repo.sessionCount} {repo.sessionCount === 1 ? 'session' : 'sessions'}
                              </span>
                              {repo.inferredLevel !== 'uncalibrated' && (
                                <span className="session-badge level">
                                  Depth: {capitalize(repo.inferredLevel)}
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

                        <div className="repo-progress-bar-track" aria-label={`${repo.progressPercent}% mastery`}>
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
                                <span className="repo-pillar-chip-state">{MASTERY_LABELS[mastery]}</span>
                              </div>
                            );
                          })}
                        </div>

                        {customTopics.length > 0 && (
                          <div className="repo-custom-topics-row">
                            <span className="repo-custom-topics-label">
                              Custom topics ({customTopics.length}):
                            </span>
                            <div className="repo-custom-topics-chips">
                              {customTopics.map((topic) => (
                                <span
                                  key={topic.id}
                                  className={`mastery-pill mastery-${topic.mastery}`}
                                  title={topic.notes || topic.title}
                                >
                                  {topic.title} · {MASTERY_LABELS[topic.mastery]}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="repo-progress-card-footer">
                          <div className="repo-progress-stats">
                            <span>
                              <strong>{repo.exploredTopicsCount}</strong>/{repo.totalTopicsCount} topics explored
                            </span>
                            <span>·</span>
                            <span>
                              <strong>{repo.solidTopicsCount}</strong> solid
                            </span>
                            <span>·</span>
                            <span>{repo.observedFilesCount} files</span>
                            <span>·</span>
                            <span>{repo.totalMessagesCount} msgs</span>
                            <span>·</span>
                            <span>Updated {formatRelativeTime(repo.lastUpdatedAt)}</span>
                          </div>

                          <div className="repo-progress-actions">
                            {!isLatestActive && (
                              <button
                                type="button"
                                className="primary-pill-btn compact"
                                disabled={loading}
                                onClick={() => {
                                  onResumeSession(repo.lastSessionId);
                                  onClose();
                                }}
                              >
                                <Play size={12} />
                                <span>Resume Latest</span>
                              </button>
                            )}
                            <button
                              type="button"
                              className="chip-button"
                              disabled={loading}
                              title="Start a new session on this repository while carrying over your topic mastery and depth calibration"
                              onClick={() => {
                                onStartRepoSession(repo.repoPath, { startFresh: false });
                                onClose();
                              }}
                            >
                              <Plus size={12} />
                              <span>New Session (Keep Progress)</span>
                            </button>
                            <button
                              type="button"
                              className="chip-button"
                              disabled={loading}
                              title="Start a brand-new onboarding session on this repository from scratch"
                              onClick={() => {
                                onStartRepoSession(repo.repoPath, { startFresh: true });
                                onClose();
                              }}
                            >
                              <RotateCcw size={12} />
                              <span>Start Fresh</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {tab === 'sessions' && (
            <>
              {repoProgress.length > 1 && (
                <div className="sessions-filter-row">
                  <span className="sessions-filter-label">Filter by repository:</span>
                  <div className="sessions-filter-chips">
                    <button
                      type="button"
                      className={`chip-button ${repoFilter === 'all' ? 'active-chip' : ''}`}
                      onClick={() => setRepoFilter('all')}
                    >
                      All ({sessions.length})
                    </button>
                    {repoProgress.map((r) => (
                      <button
                        key={r.repoPath}
                        type="button"
                        className={`chip-button ${repoFilter === r.repoPath ? 'active-chip' : ''}`}
                        onClick={() => setRepoFilter(r.repoPath)}
                      >
                        {r.repoName} ({r.sessionCount})
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {filteredSessions.length === 0 ? (
                <div className="sessions-empty-state">
                  <History size={24} className="explorer-empty-icon" />
                  <p>No saved sessions found.</p>
                </div>
              ) : (
                <div className="session-history-list">
                  {filteredSessions.map((sess) => {
                    const isCurrent = sess.id === activeSessionId;
                    const stageMeta = ONBOARDING_STAGES[sess.currentStage] ?? ONBOARDING_STAGES[0];
                    return (
                      <div
                        key={sess.id}
                        className={`session-history-row ${isCurrent ? 'is-current' : ''}`}
                      >
                        <div className="session-history-main">
                          <div className="session-history-top">
                            <span className="session-history-repo">{sess.repoName}</span>
                            {isCurrent && <span className="session-badge active">Current Session</span>}
                            <span className="session-badge">
                              Stage {sess.currentStage}: {stageMeta.shortLabel}
                            </span>
                            <span className="session-badge">
                              {sess.progressPercent}% mastery ({sess.topicsExploredCount}/{sess.totalTopicsCount} topics)
                            </span>
                          </div>

                          <div className="session-history-topic">
                            Active topic: <strong>{sess.activeTopicTitle}</strong>
                          </div>

                          <div className="session-history-meta">
                            <span>
                              <MessageSquare size={11} />
                              {sess.messageCount} {sess.messageCount === 1 ? 'message' : 'messages'}
                            </span>
                            <span>·</span>
                            <span>{sess.observedFilesCount} files inspected</span>
                            <span>·</span>
                            <span>
                              <Clock size={11} />
                              Updated {formatRelativeTime(sess.updatedAt)}
                            </span>
                          </div>
                        </div>

                        <div className="session-history-actions">
                          {isCurrent ? (
                            <span className="session-active-indicator">In Progress</span>
                          ) : (
                            <button
                              type="button"
                              className="primary-pill-btn compact"
                              disabled={loading}
                              onClick={() => {
                                onResumeSession(sess.id);
                                onClose();
                              }}
                            >
                              <span>Resume</span>
                              <ArrowRight size={12} />
                            </button>
                          )}

                          <button
                            type="button"
                            className="icon-button danger-hover"
                            disabled={loading}
                            title="Delete this session"
                            aria-label={`Delete session ${sess.id}`}
                            onClick={() => onDeleteSession(sess.id)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function formatRelativeTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (diffSec < 45) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(time).toLocaleDateString();
}
