import { ArrowRight, FolderOpen, Lock, Settings2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { HealthInfo, ProviderSelection } from '../../shared/types';

interface RepoWelcomeProps {
  health: HealthInfo | null;
  provider: ProviderSelection;
  loading: boolean;
  error: string | null;
  onStartSession: (repoPath: string) => void;
  onOpenSettings: () => void;
}

export function RepoWelcome({
  health,
  provider,
  loading,
  error,
  onStartSession,
  onOpenSettings,
}: RepoWelcomeProps) {
  const [repoPath, setRepoPath] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!repoPath.trim() || loading) return;
    onStartSession(repoPath.trim());
  }

  return (
    <div className="welcome-container">
      <div className="welcome-inner">
        <div className="welcome-badge">
          <Sparkles size={14} />
          <span>Senior Architect · Repository Onboarding</span>
        </div>

        <h1 className="welcome-title">Understand any codebase, from the root up.</h1>

        <p className="welcome-subtitle">
          Point Scavenger at a local repository. It starts with read-only root reconnaissance,
          calibrates to your background, and walks you through purpose, architecture, core flows,
          and git evolution with live diagrams.
        </p>

        <form className="repo-form" onSubmit={handleSubmit}>
          <FolderOpen size={18} color="#5f6368" />
          <input
            type="text"
            className="repo-input"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="/path/to/local/repository"
            disabled={loading}
            autoFocus
          />
          <button
            type="submit"
            className="primary-pill-btn"
            disabled={loading || !repoPath.trim()}
          >
            <span>{loading ? 'Inspecting…' : 'Start Onboarding'}</span>
            <ArrowRight size={15} />
          </button>
        </form>

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
            </span>
          </button>

          <span className="quick-chip" style={{ cursor: 'default' }}>
            <Lock size={13} className="readonly-icon" />
            <span>Strict read-only enforced</span>
          </span>
        </div>

        {error && <div className="error-banner">{error}</div>}

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
    </div>
  );
}
