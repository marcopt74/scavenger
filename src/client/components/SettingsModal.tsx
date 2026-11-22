import { X } from 'lucide-react';
import { useState } from 'react';
import type { HealthInfo, ProviderId, ProviderSelection } from '../../shared/types';

interface SettingsModalProps {
  health: HealthInfo | null;
  provider: ProviderSelection;
  onSave: (next: ProviderSelection) => void;
  onClose: () => void;
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  google: 'Google Gemini (@ai-sdk/google)',
  openai: 'OpenAI (@ai-sdk/openai)',
  anthropic: 'Anthropic Claude (@ai-sdk/anthropic)',
  'openai-compatible': 'OpenAI-Compatible (Ollama / OpenRouter)',
  demo: 'Local Grounded Demo (no API key)',
};

const MODEL_PLACEHOLDERS: Record<ProviderId, string> = {
  google: 'gemini-2.5-flash',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  'openai-compatible': 'llama3.2',
  demo: 'local-grounded-demo',
};

export function SettingsModal({ health, provider, onSave, onClose }: SettingsModalProps) {
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>(provider.provider);
  const [model, setModel] = useState(provider.model || '');
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl || '');

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      provider: selectedProvider,
      model: model.trim() || MODEL_PLACEHOLDERS[selectedProvider],
      baseUrl: selectedProvider === 'openai-compatible' ? baseUrl.trim() || undefined : undefined,
    });
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Agent & Safety Settings</h3>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSave}>
          <div className="modal-body">
            <div className="field-group">
              <label className="field-label" htmlFor="provider-select">
                LLM Provider
              </label>
              <select
                id="provider-select"
                className="field-select"
                value={selectedProvider}
                onChange={(e) => {
                  const next = e.target.value as ProviderId;
                  setSelectedProvider(next);
                  setModel(MODEL_PLACEHOLDERS[next]);
                }}
              >
                {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) => {
                  const ready = health?.configuredProviders[id];
                  return (
                    <option key={id} value={id}>
                      {PROVIDER_LABELS[id]} {ready ? '· Ready' : '· Needs .env key'}
                    </option>
                  );
                })}
              </select>
            </div>

            {selectedProvider !== 'demo' && (
              <div className="field-group">
                <label className="field-label" htmlFor="model-input">
                  Model ID
                </label>
                <input
                  id="model-input"
                  className="field-input"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={MODEL_PLACEHOLDERS[selectedProvider]}
                />
              </div>
            )}

            {selectedProvider === 'openai-compatible' && (
              <div className="field-group">
                <label className="field-label" htmlFor="baseurl-input">
                  Base URL (optional override)
                </label>
                <input
                  id="baseurl-input"
                  className="field-input"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="http://localhost:11434/v1"
                />
              </div>
            )}

            <div className="info-box">
              <strong>Read-Only Guardrails Active</strong>
              <br />
              • Filesystem tools (<code>list_tree</code>, <code>read_file</code>, <code>grep_search</code>) are
              canonical-path confined inside the target repo with symlink-escape blocking.
              <br />
              • Git inspection runs without a shell, strictly allowlists read-only subcommands, and
              sets <code>GIT_OPTIONAL_LOCKS=0</code>.
              <br />
              • Visual pipeline: Mermaid SVG (ready) · D2 CLI (
              {health?.d2Available ? 'installed' : 'not installed, fallback ready'}) · Concept images (
              {health?.imageGenAvailable ? 'API ready' : 'vector fallback'}).
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="chip-button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary-pill-btn">
              Apply
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
