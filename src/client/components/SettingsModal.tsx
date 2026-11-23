import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PROVIDER_MODEL_PRESETS } from '../../shared/types';
import type {
  CopilotDeviceFlowStartResponse,
  HealthInfo,
  ProviderId,
  ProviderModelPreset,
  ProviderSelection,
  PublicSettings,
  TestConnectionResult,
  UpdateSettingsPayload,
} from '../../shared/types';
import {
  fetchCopilotModels,
  fetchSettings,
  pollCopilotDeviceFlow,
  saveSettings,
  startCopilotDeviceFlow,
  testProviderConnection,
} from '../api/client';

interface SettingsModalProps {
  health: HealthInfo | null;
  provider: ProviderSelection;
  onSaved: (nextProvider: ProviderSelection, nextHealth: HealthInfo) => void;
  onClose: () => void;
}

type SettingsTab = 'models' | 'keys' | 'visuals';
type RealProviderId = Exclude<ProviderId, 'demo'>;

const REAL_PROVIDERS: readonly RealProviderId[] = [
  'copilot',
  'google',
  'openai',
  'anthropic',
  'openai-compatible',
];

const ALL_PROVIDERS: readonly ProviderId[] = [
  'copilot',
  'google',
  'openai',
  'anthropic',
  'openai-compatible',
  'demo',
];

const PROVIDER_META: Record<
  ProviderId,
  { name: string; subtitle: string; keyPlaceholder: string; keyHint: string }
> = {
  copilot: {
    name: 'GitHub Copilot',
    subtitle: 'GPT-4.1 · Claude Sonnet 4 · Gemini 2.5 Pro',
    keyPlaceholder: 'ghu_… or gho_… (or click Sign in with GitHub)',
    keyHint: 'Auto-detects local Copilot IDE/CLI auth, or sign in via GitHub Device Flow',
  },
  google: {
    name: 'Google Gemini',
    subtitle: 'Gemini 2.5 Flash / Pro',
    keyPlaceholder: 'AIzaSy…',
    keyHint: 'Get a key at Google AI Studio (aistudio.google.com)',
  },
  openai: {
    name: 'OpenAI',
    subtitle: 'GPT-4o / GPT-4.1 / o3-mini',
    keyPlaceholder: 'sk-proj-…',
    keyHint: 'Get a key at platform.openai.com/api-keys',
  },
  anthropic: {
    name: 'Anthropic Claude',
    subtitle: 'Claude Sonnet 4 / 3.7 / Haiku',
    keyPlaceholder: 'sk-ant-…',
    keyHint: 'Get a key at console.anthropic.com',
  },
  'openai-compatible': {
    name: 'OpenAI-Compatible',
    subtitle: 'Ollama · LM Studio · OpenRouter',
    keyPlaceholder: 'Optional API key (leave empty for Ollama)',
    keyHint: 'Works with local Ollama, LM Studio, vLLM, or OpenRouter',
  },
  demo: {
    name: 'Local Demo Mode',
    subtitle: 'Zero API key · Grounded read-only',
    keyPlaceholder: '',
    keyHint: 'Runs locally without external LLM calls',
  },
};

const COMPAT_ENDPOINT_PRESETS = [
  { label: 'Ollama', url: 'http://localhost:11434/v1' },
  { label: 'LM Studio', url: 'http://localhost:1234/v1' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
] as const;

export function SettingsModal({ health, provider, onSaved, onClose }: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>('models');
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editable form state
  const [activeProvider, setActiveProvider] = useState<ProviderId>(provider.provider);
  const [models, setModels] = useState<Record<RealProviderId, string>>({
    copilot: PROVIDER_MODEL_PRESETS.copilot[0].id,
    google: PROVIDER_MODEL_PRESETS.google[0].id,
    openai: PROVIDER_MODEL_PRESETS.openai[0].id,
    anthropic: PROVIDER_MODEL_PRESETS.anthropic[0].id,
    'openai-compatible': PROVIDER_MODEL_PRESETS['openai-compatible'][0].id,
  });
  const [compatBaseUrl, setCompatBaseUrl] = useState(
    provider.provider === 'openai-compatible' ? provider.baseUrl || '' : ''
  );
  const [copilotDomain, setCopilotDomain] = useState(
    provider.provider === 'copilot' ? provider.baseUrl || '' : ''
  );
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<RealProviderId, string>>({
    copilot: '',
    google: '',
    openai: '',
    anthropic: '',
    'openai-compatible': '',
  });
  const [clearKeys, setClearKeys] = useState<Record<RealProviderId, boolean>>({
    copilot: false,
    google: false,
    openai: false,
    anthropic: false,
    'openai-compatible': false,
  });
  const [revealedKeys, setRevealedKeys] = useState<Record<RealProviderId, boolean>>({
    copilot: false,
    google: false,
    openai: false,
    anthropic: false,
    'openai-compatible': false,
  });

  // Dynamic GitHub Copilot models & Device Flow state
  const [copilotModels, setCopilotModels] = useState<readonly ProviderModelPreset[]>(
    PROVIDER_MODEL_PRESETS.copilot
  );
  const [copilotModelsSource, setCopilotModelsSource] = useState<'live' | 'presets'>('presets');
  const [loadingCopilotModels, setLoadingCopilotModels] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<CopilotDeviceFlowStartResponse | null>(null);
  const [deviceStarting, setDeviceStarting] = useState(false);
  const [deviceCopied, setDeviceCopied] = useState(false);

  // Visual settings state
  const [imageGenEnabled, setImageGenEnabled] = useState(true);
  const [useActiveModelForVisuals, setUseActiveModelForVisuals] = useState(true);
  const [geminiImageModel, setGeminiImageModel] = useState('imagen-3.0-generate-002');
  const [openaiImageModel, setOpenaiImageModel] = useState('gpt-image-1');

  // Connection test state
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);

  // Prevent closing modal when a text-selection drag starts inside the panel and ends on the backdrop
  const backdropMouseDownRef = useRef(false);

  async function loadCopilotModelCatalog(refresh = false, domainOverride?: string) {
    setLoadingCopilotModels(true);
    try {
      const effectiveDomain = domainOverride !== undefined ? domainOverride : copilotDomain;
      const res = await fetchCopilotModels(refresh, effectiveDomain);
      if (res.models.length > 0) {
        setCopilotModels(res.models);
        setCopilotModelsSource(res.source);
      }
    } catch {
      // Keep existing presets on transient error
    } finally {
      setLoadingCopilotModels(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSettings()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setActiveProvider(provider.provider || loaded.activeProvider);
        setModels({
          copilot:
            provider.provider === 'copilot' && provider.model
              ? provider.model
              : loaded.providers.copilot.model,
          google:
            provider.provider === 'google' && provider.model
              ? provider.model
              : loaded.providers.google.model,
          openai:
            provider.provider === 'openai' && provider.model
              ? provider.model
              : loaded.providers.openai.model,
          anthropic:
            provider.provider === 'anthropic' && provider.model
              ? provider.model
              : loaded.providers.anthropic.model,
          'openai-compatible':
            provider.provider === 'openai-compatible' && provider.model
              ? provider.model
              : loaded.providers['openai-compatible'].model,
        });
        setCompatBaseUrl(
          (provider.provider === 'openai-compatible' ? provider.baseUrl : undefined) ??
            loaded.providers['openai-compatible'].baseUrl ??
            ''
        );
        const initialCopilotDomain =
          (provider.provider === 'copilot' ? provider.baseUrl : undefined) ??
          loaded.providers.copilot.baseUrl ??
          '';
        setCopilotDomain(initialCopilotDomain);
        setImageGenEnabled(loaded.visuals.imageGenEnabled);
        setUseActiveModelForVisuals(loaded.visuals.useActiveModelForVisuals ?? true);
        setGeminiImageModel(loaded.visuals.geminiImageModel);
        setOpenaiImageModel(loaded.visuals.openaiImageModel);
        setLoading(false);

        if (loaded.providers.copilot.ready) {
          void loadCopilotModelCatalog(false, initialCopilotDomain);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Unable to load saved settings.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // Load once on open so prop refreshes never wipe in-progress edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!deviceFlow) return;
    let cancelled = false;
    let pollIntervalMs = Math.max(deviceFlow.interval || 5, 3) * 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flowDomain = deviceFlow.domain || copilotDomain.trim() || undefined;

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await pollCopilotDeviceFlow(deviceFlow.deviceCode, flowDomain);
        if (cancelled) return;

        if (res.status === 'complete' && res.settings && res.health) {
          setSettings(res.settings);
          setActiveProvider('copilot');
          const savedDomain = res.settings.providers.copilot.baseUrl || '';
          setCopilotDomain(savedDomain);
          setClearKeys((prev) => ({ ...prev, copilot: false }));
          setApiKeyDrafts((prev) => ({ ...prev, copilot: '' }));
          setDeviceFlow(null);
          setTestResult({
            ok: true,
            provider: 'copilot',
            model: models.copilot,
            latencyMs: 0,
            message: `Signed in with GitHub Copilot${savedDomain ? ` (${savedDomain})` : ''}. Fetching available models…`,
          });
          onSaved(
            {
              provider: 'copilot',
              model: models.copilot || res.settings.providers.copilot.model,
              baseUrl: savedDomain || undefined,
            },
            res.health
          );
          void loadCopilotModelCatalog(true, savedDomain);
          return;
        }

        if (res.status === 'slow_down') {
          pollIntervalMs = Math.max((res.interval || 10) * 1000, pollIntervalMs + 5000);
        } else if (res.status === 'expired' || res.status === 'denied') {
          setDeviceFlow(null);
          setError(res.message || 'GitHub Copilot sign-in did not complete.');
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setDeviceFlow(null);
        setError(err instanceof Error ? err.message : 'GitHub Copilot device sign-in failed.');
        return;
      }

      if (!cancelled) {
        timer = setTimeout(() => void tick(), pollIntervalMs);
      }
    };

    timer = setTimeout(() => void tick(), pollIntervalMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceFlow]);

  async function handleStartDeviceFlow() {
    setDeviceStarting(true);
    setError(null);
    setTestResult(null);
    try {
      const started = await startCopilotDeviceFlow(copilotDomain.trim() || undefined);
      setDeviceFlow(started);
      setDeviceCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start GitHub Copilot sign-in.');
    } finally {
      setDeviceStarting(false);
    }
  }

  function handleCopyDeviceCode(code: string) {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(code).then(() => {
        setDeviceCopied(true);
        setTimeout(() => setDeviceCopied(false), 2000);
      });
    }
  }

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

  function isProviderEffectivelyReady(id: ProviderId): boolean {
    if (id === 'demo') return true;
    if (id === 'openai-compatible') {
      return Boolean(compatBaseUrl.trim());
    }
    if (apiKeyDrafts[id].trim().length > 0) return true;
    const saved = settings?.providers[id];
    if (!saved) return Boolean(health?.configuredProviders[id]);
    if (clearKeys[id] && saved.keySource === 'settings') {
      // If user is clearing the saved key, we won't know env fallback until save; mark pending
      return false;
    }
    return saved.hasKey;
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const isReal = activeProvider !== 'demo';
      const baseUrlForTest =
        activeProvider === 'openai-compatible'
          ? compatBaseUrl.trim() || undefined
          : activeProvider === 'copilot'
            ? copilotDomain.trim() || undefined
            : undefined;
      const result = await testProviderConnection({
        provider: activeProvider,
        model: isReal ? models[activeProvider].trim() || undefined : undefined,
        baseUrl: baseUrlForTest,
        apiKey: isReal ? apiKeyDrafts[activeProvider].trim() || undefined : undefined,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({
        ok: false,
        provider: activeProvider,
        model: activeProvider === 'demo' ? 'local-grounded-demo' : models[activeProvider],
        latencyMs: 0,
        message: err instanceof Error ? err.message : 'Connection test failed.',
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);

    const payload: UpdateSettingsPayload = {
      activeProvider,
      providers: {
        copilot: {
          model: models.copilot.trim(),
          baseUrl: copilotDomain.trim(),
          apiKey: apiKeyDrafts.copilot.trim() || undefined,
          clearApiKey: clearKeys.copilot || undefined,
        },
        google: {
          model: models.google.trim(),
          apiKey: apiKeyDrafts.google.trim() || undefined,
          clearApiKey: clearKeys.google || undefined,
        },
        openai: {
          model: models.openai.trim(),
          apiKey: apiKeyDrafts.openai.trim() || undefined,
          clearApiKey: clearKeys.openai || undefined,
        },
        anthropic: {
          model: models.anthropic.trim(),
          apiKey: apiKeyDrafts.anthropic.trim() || undefined,
          clearApiKey: clearKeys.anthropic || undefined,
        },
        'openai-compatible': {
          model: models['openai-compatible'].trim(),
          baseUrl: compatBaseUrl.trim(),
          apiKey: apiKeyDrafts['openai-compatible'].trim() || undefined,
          clearApiKey: clearKeys['openai-compatible'] || undefined,
        },
      },
      visuals: {
        imageGenEnabled,
        useActiveModelForVisuals,
        geminiImageModel: geminiImageModel.trim(),
        openaiImageModel: openaiImageModel.trim(),
      },
    };

    try {
      const { settings: nextSettings, health: nextHealth } = await saveSettings(payload);
      const selectedCfg = nextSettings.providers[activeProvider];
      const nextSelection: ProviderSelection = {
        provider: activeProvider,
        model: selectedCfg.model,
        baseUrl:
          activeProvider === 'openai-compatible' || activeProvider === 'copilot'
            ? selectedCfg.baseUrl
            : undefined,
      };
      onSaved(nextSelection, nextHealth);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  }

  function renderKeyBadge(id: RealProviderId) {
    const cfg = settings?.providers[id];
    const hasDraft = apiKeyDrafts[id].trim().length > 0;
    if (hasDraft) {
      return <span className="secret-status-pill source-pending">New key staged</span>;
    }
    if (clearKeys[id]) {
      return <span className="secret-status-pill source-removing">Will remove on save</span>;
    }
    if (cfg?.keySource === 'settings') {
      return <span className="secret-status-pill source-settings">Saved in Settings</span>;
    }
    if (cfg?.keySource === 'env') {
      return <span className="secret-status-pill source-env">From .env</span>;
    }
    if (cfg?.keySource === 'local') {
      return (
        <span className="secret-status-pill source-local">
          Auto-detected ({cfg.sourceDetail || 'local'})
        </span>
      );
    }
    return (
      <span className="secret-status-pill source-none">
        {id === 'openai-compatible' ? 'Optional' : 'Not set'}
      </span>
    );
  }

  function renderCopilotDeviceFlowBox() {
    if (!deviceFlow) return null;
    const hostLabel = deviceFlow.domain && deviceFlow.domain !== 'github.com'
      ? deviceFlow.domain
      : 'GitHub';
    return (
      <div className="copilot-device-box" role="region" aria-label="GitHub Copilot Device Login">
        <div className="copilot-device-top">
          <span>
            Enter this one-time code on <strong>{hostLabel}</strong> to authorize Scavenger with your Copilot account:
          </span>
          <button
            type="button"
            className="settings-link-btn"
            onClick={() => setDeviceFlow(null)}
          >
            Cancel
          </button>
        </div>
        <div className="copilot-device-code-row">
          <code className="copilot-device-code">{deviceFlow.userCode}</code>
          <button
            type="button"
            className="chip-button"
            onClick={() => handleCopyDeviceCode(deviceFlow.userCode)}
          >
            <Copy size={13} />
            <span>{deviceCopied ? 'Copied!' : 'Copy code'}</span>
          </button>
          <a
            href={deviceFlow.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className="primary-pill-btn copilot-device-link"
          >
            <span>Open {hostLabel}</span>
            <ExternalLink size={13} />
          </a>
        </div>
        <div className="copilot-device-waiting">
          <Loader2 size={13} className="explorer-spinner" />
          <span>Waiting for authorization on {deviceFlow.verificationUri}…</span>
        </div>
      </div>
    );
  }

  const activeRealProvider: RealProviderId | null =
    activeProvider === 'demo' ? null : activeProvider;

  const activeProviderPresets: readonly ProviderModelPreset[] =
    activeRealProvider === 'copilot'
      ? copilotModels
      : activeRealProvider
        ? PROVIDER_MODEL_PRESETS[activeRealProvider]
        : [];

  const isRemoteCompatEndpoint =
    activeRealProvider === 'openai-compatible' &&
    compatBaseUrl.trim().length > 0 &&
    !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(compatBaseUrl.trim());

  const compatHasKey =
    apiKeyDrafts['openai-compatible'].trim().length > 0 ||
    (Boolean(settings?.providers['openai-compatible'].hasKey) && !clearKeys['openai-compatible']);

  const showQuickKeyCallout =
    activeRealProvider !== null &&
    ((activeRealProvider !== 'openai-compatible' &&
      !isProviderEffectivelyReady(activeRealProvider)) ||
      (isRemoteCompatEndpoint && !compatHasKey));

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
        className="modal-panel settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="settings-header-copy">
            <h3 id="settings-modal-title">Settings</h3>
            <span className="settings-header-sub">
              Configure providers, API keys, models, and visuals — no <code>.env</code> editing required
            </span>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'models'}
            className={`settings-tab-btn ${tab === 'models' ? 'active' : ''}`}
            onClick={() => setTab('models')}
          >
            <Cpu size={14} />
            <span>Models &amp; Provider</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'keys'}
            className={`settings-tab-btn ${tab === 'keys' ? 'active' : ''}`}
            onClick={() => setTab('keys')}
          >
            <KeyRound size={14} />
            <span>API Keys</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'visuals'}
            className={`settings-tab-btn ${tab === 'visuals' ? 'active' : ''}`}
            onClick={() => setTab('visuals')}
          >
            <Sparkles size={14} />
            <span>Visuals &amp; Safety</span>
          </button>
        </div>

        <div className="settings-form">
          <div className="modal-body settings-body">
            {loading ? (
              <div className="settings-loading">
                <Loader2 size={18} className="explorer-spinner" />
                <span>Loading local configuration…</span>
              </div>
            ) : tab === 'models' ? (
              <>
                <div className="field-group">
                  <label className="field-label">Active LLM Provider</label>
                  <div className="provider-grid">
                    {ALL_PROVIDERS.map((id) => {
                      const ready = isProviderEffectivelyReady(id);
                      const selected = activeProvider === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`provider-card ${selected ? 'selected' : ''}`}
                          onClick={() => {
                            setActiveProvider(id);
                            setTestResult(null);
                          }}
                        >
                          <div className="provider-card-top">
                            <span className="provider-card-name">{PROVIDER_META[id].name}</span>
                            <span className={`provider-ready-pill ${ready ? 'ready' : 'missing'}`}>
                              {id === 'demo' ? 'Local' : ready ? 'Ready' : 'Needs setup'}
                            </span>
                          </div>
                          <span className="provider-card-sub">{PROVIDER_META[id].subtitle}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {activeRealProvider && (
                  <>
                    {activeRealProvider === 'copilot' && (
                      <>
                        <div className="field-group">
                          <label className="field-label" htmlFor="copilot-domain-input">
                            GitHub Domain <span className="model-source-note">(leave blank for github.com, or enter your Enterprise / GHE domain)</span>
                          </label>
                          <div className="secret-input-wrap">
                            <input
                              id="copilot-domain-input"
                              type="text"
                              className="field-input field-mono secret-input"
                              value={copilotDomain}
                              onChange={(e) => {
                                setCopilotDomain(e.target.value);
                                setDeviceFlow(null);
                                setTestResult(null);
                              }}
                              placeholder="github.com (or e.g. company.ghe.com / github.company.com)"
                              autoComplete="off"
                              spellCheck={false}
                            />
                            {copilotDomain && (
                              <button
                                type="button"
                                className="secret-eye-btn"
                                onClick={() => {
                                  setCopilotDomain('');
                                  setDeviceFlow(null);
                                  setTestResult(null);
                                }}
                                title="Reset to github.com"
                                aria-label="Reset to github.com"
                              >
                                <X size={14} />
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="copilot-auth-bar">
                          <div className="copilot-auth-status">
                            <span className="field-label" style={{ marginBottom: 0 }}>
                              Copilot Authentication
                            </span>
                            {renderKeyBadge('copilot')}
                            {settings?.providers.copilot.maskedKey && !clearKeys.copilot && (
                              <span className="secret-masked-tag">
                                {settings.providers.copilot.maskedKey}
                              </span>
                            )}
                          </div>
                          <div className="copilot-auth-actions">
                            <button
                              type="button"
                              className="chip-button"
                              disabled={deviceStarting || Boolean(deviceFlow)}
                              onClick={() => void handleStartDeviceFlow()}
                            >
                              {deviceStarting ? (
                                <Loader2 size={13} className="explorer-spinner" />
                              ) : (
                                <KeyRound size={13} />
                              )}
                              <span>
                                {isProviderEffectivelyReady('copilot')
                                  ? `Re-sign in (${copilotDomain.trim() || 'github.com'})`
                                  : `Sign in with GitHub (${copilotDomain.trim() || 'github.com'})`}
                              </span>
                            </button>
                          </div>
                        </div>
                      </>
                    )}

                    {activeRealProvider === 'copilot' && renderCopilotDeviceFlowBox()}

                    <div className="field-group">
                      <div className="field-label-row">
                        <label className="field-label" htmlFor="active-model-input">
                          Model for {PROVIDER_META[activeRealProvider].name}
                          {activeRealProvider === 'copilot' && (
                            <span className="model-source-note">
                              {copilotModelsSource === 'live'
                                ? ` · ${copilotModels.length} live from your Copilot subscription`
                                : ' · presets'}
                            </span>
                          )}
                        </label>
                        {activeRealProvider === 'copilot' && isProviderEffectivelyReady('copilot') && (
                          <button
                            type="button"
                            className="settings-link-btn"
                            disabled={loadingCopilotModels}
                            onClick={() => void loadCopilotModelCatalog(true)}
                            title="Fetch models enabled on your GitHub Copilot account"
                          >
                            <RefreshCw
                              size={12}
                              className={loadingCopilotModels ? 'explorer-spinner' : ''}
                              style={{ marginRight: 4, verticalAlign: '-1px' }}
                            />
                            <span>{loadingCopilotModels ? 'Refreshing…' : 'Refresh models'}</span>
                          </button>
                        )}
                      </div>
                      <div className="model-presets-row">
                        {activeProviderPresets.map((preset) => {
                          const isChosen = models[activeRealProvider].trim() === preset.id;
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              className={`model-preset-chip ${isChosen ? 'active' : ''}`}
                              onClick={() => {
                                setModels((prev) => ({ ...prev, [activeRealProvider]: preset.id }));
                                setTestResult(null);
                              }}
                            >
                              <span className="model-preset-label">{preset.label}</span>
                              <span className="model-preset-note">{preset.note}</span>
                            </button>
                          );
                        })}
                      </div>
                      <div className="secret-input-wrap">
                        <input
                          id="active-model-input"
                          type="text"
                          className="field-input field-mono secret-input"
                          value={models[activeRealProvider]}
                          onChange={(e) => {
                            setModels((prev) => ({ ...prev, [activeRealProvider]: e.target.value }));
                            setTestResult(null);
                          }}
                          placeholder={
                            activeRealProvider === 'openai-compatible' && isRemoteCompatEndpoint
                              ? 'e.g. anthropic/claude-sonnet-4 or google/gemini-2.5-flash'
                              : (activeProviderPresets[0]?.id ??
                                PROVIDER_MODEL_PRESETS[activeRealProvider][0].id)
                          }
                          autoComplete="off"
                          spellCheck={false}
                        />
                        {models[activeRealProvider] && (
                          <button
                            type="button"
                            className="secret-eye-btn"
                            onClick={() => {
                              setModels((prev) => ({ ...prev, [activeRealProvider]: '' }));
                              setTestResult(null);
                            }}
                            title="Clear model ID"
                            aria-label="Clear model ID"
                          >
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    </div>

                    {activeRealProvider === 'openai-compatible' && (
                      <div className="field-group">
                        <label className="field-label" htmlFor="quick-baseurl-input">
                          Endpoint Base URL
                        </label>
                        <div className="endpoint-presets-row">
                          {COMPAT_ENDPOINT_PRESETS.map((preset) => (
                            <button
                              key={preset.label}
                              type="button"
                              className={`endpoint-preset-chip ${compatBaseUrl.trim() === preset.url ? 'active' : ''}`}
                              onClick={() => {
                                setCompatBaseUrl(preset.url);
                                setTestResult(null);
                              }}
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                        <input
                          id="quick-baseurl-input"
                          type="text"
                          className="field-input field-mono"
                          value={compatBaseUrl}
                          onChange={(e) => {
                            setCompatBaseUrl(e.target.value);
                            setTestResult(null);
                          }}
                          placeholder="http://localhost:11434/v1"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </div>
                    )}

                    {/* Quick inline API key setup if selected provider (or remote OpenAI-compatible like OpenRouter) needs one */}
                    {showQuickKeyCallout && (
                      <div className="quick-key-callout">
                        <div className="quick-key-header">
                          <KeyRound size={14} />
                          <span>
                            {activeRealProvider === 'openai-compatible'
                              ? 'Add your endpoint API key (required for OpenRouter / remote APIs)'
                              : `Add your ${PROVIDER_META[activeRealProvider].name} API key to activate`}
                          </span>
                        </div>
                        <div className="secret-input-wrap">
                          <input
                            type={revealedKeys[activeRealProvider] ? 'text' : 'password'}
                            className="field-input field-mono secret-input"
                            value={apiKeyDrafts[activeRealProvider]}
                            onChange={(e) => {
                              const val = e.target.value;
                              setApiKeyDrafts((prev) => ({ ...prev, [activeRealProvider]: val }));
                              if (val.trim()) {
                                setClearKeys((prev) => ({ ...prev, [activeRealProvider]: false }));
                              }
                              setTestResult(null);
                            }}
                            placeholder={
                              activeRealProvider === 'openai-compatible'
                                ? 'sk-or-v1-…'
                                : PROVIDER_META[activeRealProvider].keyPlaceholder
                            }
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <button
                            type="button"
                            className="secret-eye-btn"
                            onClick={() =>
                              setRevealedKeys((prev) => ({
                                ...prev,
                                [activeRealProvider]: !prev[activeRealProvider],
                              }))
                            }
                            aria-label="Toggle API key visibility"
                          >
                            {revealedKeys[activeRealProvider] ? (
                              <EyeOff size={15} />
                            ) : (
                              <Eye size={15} />
                            )}
                          </button>
                        </div>
                        <span className="field-hint">
                          {activeRealProvider === 'openai-compatible'
                            ? 'OpenRouter keys can be created at openrouter.ai/keys'
                            : PROVIDER_META[activeRealProvider].keyHint}
                        </span>
                      </div>
                    )}
                  </>
                )}

                <div className="connection-test-row">
                  <button
                    type="button"
                    className="chip-button"
                    disabled={testing}
                    onClick={() => void handleTestConnection()}
                  >
                    {testing ? (
                      <Loader2 size={14} className="explorer-spinner" />
                    ) : (
                      <PlugZap size={14} />
                    )}
                    <span>{testing ? 'Testing connection…' : 'Test Connection'}</span>
                  </button>

                  {activeRealProvider && isProviderEffectivelyReady(activeRealProvider) && (
                    <button
                      type="button"
                      className="settings-link-btn"
                      onClick={() => setTab('keys')}
                    >
                      Manage API keys →
                    </button>
                  )}
                </div>

                {testResult && (
                  <div
                    className={`test-result-banner ${testResult.ok ? 'is-ok' : 'is-err'}`}
                    role="status"
                  >
                    {testResult.ok ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                    <span>{testResult.message}</span>
                  </div>
                )}
              </>
            ) : tab === 'keys' ? (
              <>
                <p className="settings-intro">
                  Keys saved here are stored locally in <code>{settings?.storagePath ?? '~/.scavenger/config.json'}</code>{' '}
                  with owner-only permissions (<code>0600</code>) and take effect immediately without restarting.
                </p>

                <div className="secret-list">
                  {REAL_PROVIDERS.map((id) => {
                    const cfg = settings?.providers[id];
                    const canRemove = cfg?.keySource === 'settings';
                    const isClearing = clearKeys[id];

                    return (
                      <div key={id} className="secret-card">
                        <div className="secret-card-header">
                          <div className="secret-card-title-group">
                            <span className="secret-card-title">{PROVIDER_META[id].name}</span>
                            {renderKeyBadge(id)}
                          </div>

                          {cfg?.maskedKey && !isClearing && (
                            <span className="secret-masked-tag" title="Currently active key (masked)">
                              {cfg.maskedKey}
                            </span>
                          )}
                        </div>

                        {id === 'copilot' && (
                          <div className="copilot-keys-actions">
                            <div className="field-group" style={{ width: '100%', marginBottom: 4 }}>
                              <label className="field-label" htmlFor="keys-copilot-domain-input">
                                GitHub Domain (optional — for organizational / Enterprise GitHub)
                              </label>
                              <input
                                id="keys-copilot-domain-input"
                                className="field-input field-mono"
                                value={copilotDomain}
                                onChange={(e) => {
                                  setCopilotDomain(e.target.value);
                                  setDeviceFlow(null);
                                }}
                                placeholder="github.com (or e.g. company.ghe.com / github.company.com)"
                              />
                            </div>
                            <button
                              type="button"
                              className="chip-button"
                              disabled={deviceStarting || Boolean(deviceFlow)}
                              onClick={() => void handleStartDeviceFlow()}
                            >
                              {deviceStarting ? (
                                <Loader2 size={13} className="explorer-spinner" />
                              ) : (
                                <KeyRound size={13} />
                              )}
                              <span>
                                Sign in with GitHub Device Flow ({copilotDomain.trim() || 'github.com'})
                              </span>
                            </button>
                            {renderCopilotDeviceFlowBox()}
                          </div>
                        )}

                        {id === 'openai-compatible' && (
                          <div className="field-group" style={{ marginBottom: 8 }}>
                            <label className="field-label" htmlFor="keys-baseurl-input">
                              Base URL
                            </label>
                            <div className="endpoint-presets-row">
                              {COMPAT_ENDPOINT_PRESETS.map((preset) => (
                                <button
                                  key={preset.label}
                                  type="button"
                                  className={`endpoint-preset-chip ${compatBaseUrl.trim() === preset.url ? 'active' : ''}`}
                                  onClick={() => setCompatBaseUrl(preset.url)}
                                >
                                  {preset.label}
                                </button>
                              ))}
                            </div>
                            <input
                              id="keys-baseurl-input"
                              className="field-input field-mono"
                              value={compatBaseUrl}
                              onChange={(e) => setCompatBaseUrl(e.target.value)}
                              placeholder="http://localhost:11434/v1"
                            />
                          </div>
                        )}

                        <div className="secret-input-row">
                          <div className="secret-input-wrap">
                            <input
                              type={revealedKeys[id] ? 'text' : 'password'}
                              className="field-input field-mono secret-input"
                              value={apiKeyDrafts[id]}
                              disabled={isClearing}
                              onChange={(e) => {
                                const val = e.target.value;
                                setApiKeyDrafts((prev) => ({ ...prev, [id]: val }));
                                if (val.trim()) {
                                  setClearKeys((prev) => ({ ...prev, [id]: false }));
                                }
                              }}
                              placeholder={
                                cfg?.hasKey
                                  ? 'Leave blank to keep existing key, or paste a new key'
                                  : PROVIDER_META[id].keyPlaceholder
                              }
                              aria-label={`${PROVIDER_META[id].name} API Key`}
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <button
                              type="button"
                              className="secret-eye-btn"
                              onClick={() =>
                                setRevealedKeys((prev) => ({ ...prev, [id]: !prev[id] }))
                              }
                              aria-label={`Toggle ${PROVIDER_META[id].name} key visibility`}
                            >
                              {revealedKeys[id] ? <EyeOff size={15} /> : <Eye size={15} />}
                            </button>
                          </div>

                          {canRemove && (
                            <button
                              type="button"
                              className={`secret-clear-btn ${isClearing ? 'is-undo' : ''}`}
                              onClick={() => {
                                setClearKeys((prev) => ({ ...prev, [id]: !prev[id] }));
                                if (!isClearing) {
                                  setApiKeyDrafts((prev) => ({ ...prev, [id]: '' }));
                                }
                              }}
                              title={isClearing ? 'Undo key removal' : 'Remove saved key'}
                            >
                              {isClearing ? <Undo2 size={14} /> : <Trash2 size={14} />}
                              <span>{isClearing ? 'Undo' : 'Remove'}</span>
                            </button>
                          )}
                        </div>

                        <span className="field-hint">{PROVIDER_META[id].keyHint}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <div className="toggle-card">
                  <div className="toggle-copy">
                    <span className="toggle-title">AI Concept Image Generation</span>
                    <span className="toggle-desc">
                      Generates editorial illustrations or bespoke architectural SVGs for mental models.
                      When disabled (or in Demo mode), Scavenger renders fast multi-layout vector concept maps.
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={imageGenEnabled}
                    className={`toggle-switch ${imageGenEnabled ? 'on' : ''}`}
                    onClick={() => setImageGenEnabled((v) => !v)}
                  >
                    <span className="toggle-thumb" />
                  </button>
                </div>

                {imageGenEnabled && (
                  <>
                    <div className="toggle-card">
                      <div className="toggle-copy">
                        <span className="toggle-title">Use active chat model for concept visuals</span>
                        <span className="toggle-desc">
                          Leverages your active session provider (
                          <strong>{PROVIDER_META[activeProvider].name}</strong>
                          {activeRealProvider
                            ? ` · ${models[activeRealProvider] || PROVIDER_MODEL_PRESETS[activeRealProvider][0].id}`
                            : ''}
                          ) first for native multimodal image output or bespoke inline{' '}
                          <code>&lt;svg viewBox=&quot;0 0 880 420&quot;&gt;</code> illustrations before
                          falling back to dedicated image endpoints or offline templates.
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-label="Use active chat model for concept visuals"
                        aria-checked={useActiveModelForVisuals}
                        className={`toggle-switch ${useActiveModelForVisuals ? 'on' : ''}`}
                        onClick={() => setUseActiveModelForVisuals((v) => !v)}
                      >
                        <span className="toggle-thumb" />
                      </button>
                    </div>

                    <div className="visual-models-grid">
                      <div className="field-group">
                        <label className="field-label" htmlFor="gemini-img-model">
                          Gemini Image Model (Fallback)
                        </label>
                        <input
                          id="gemini-img-model"
                          className="field-input field-mono"
                          value={geminiImageModel}
                          onChange={(e) => setGeminiImageModel(e.target.value)}
                          placeholder="imagen-3.0-generate-002"
                        />
                      </div>
                      <div className="field-group">
                        <label className="field-label" htmlFor="openai-img-model">
                          OpenAI Image Model (Fallback)
                        </label>
                        <input
                          id="openai-img-model"
                          className="field-input field-mono"
                          value={openaiImageModel}
                          onChange={(e) => setOpenaiImageModel(e.target.value)}
                          placeholder="gpt-image-1"
                        />
                      </div>
                    </div>
                  </>
                )}

                <div className="info-box">
                  <div className="guardrail-box-header">
                    <ShieldCheck size={15} className="readonly-icon" />
                    <strong>Read-Only Guardrails &amp; Visual Pipeline</strong>
                  </div>
                  • Filesystem tools (<code>list_tree</code>, <code>read_file</code>, <code>grep_search</code>) are
                  canonical-path confined inside the target repo with symlink-escape blocking.
                  <br />
                  • Git inspection runs without a shell, strictly allowlists read-only subcommands, and
                  sets <code>GIT_OPTIONAL_LOCKS=0</code>.
                  <br />
                  • Visual pipeline: Mermaid SVG (ready) · D2 CLI (
                  {(settings?.visuals.d2Available ?? health?.d2Available)
                    ? 'installed'
                    : 'not installed, fallback ready'}
                  ) · Concept images (
                  {!imageGenEnabled
                    ? 'editorial vector mode'
                    : useActiveModelForVisuals && activeProvider !== 'demo' && isProviderEffectivelyReady(activeProvider)
                      ? `active model (${PROVIDER_META[activeProvider].name})`
                      : (settings?.visuals.imageGenAvailable ?? health?.imageGenAvailable)
                        ? 'API ready'
                        : 'editorial vector mode'}
                  ).
                </div>
              </>
            )}

            {error && (
              <div className="error-banner" style={{ marginTop: 4 }} role="alert">
                {error}
              </div>
            )}
          </div>

          <div className="modal-footer settings-footer">
            <span className="settings-footer-note">
              Saved locally · never leaves your machine
            </span>
            <div className="explorer-footer-actions">
              <button type="button" className="chip-button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-pill-btn"
                disabled={loading || saving}
                onClick={() => void handleSave()}
              >
                {saving ? 'Saving…' : 'Save Settings'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
