import type {
  CodePeekFileResponse,
  CodePeekGitResponse,
  CopilotDeviceFlowPollResponse,
  CopilotDeviceFlowStartResponse,
  CopilotModelsResponse,
  DirectoryBrowseResponse,
  HandbookExportFormat,
  HandbookExportResponse,
  HealthInfo,
  KnowledgeBaseStatus,
  KnowledgeGraphResponse,
  OnboardingStage,
  ProviderSelection,
  PublicSettings,
  SSEEvent,
  ScanSSEEvent,
  SessionPublicState,
  SessionsListResponse,
  TestConnectionPayload,
  TestConnectionResult,
  UpdateSettingsPayload,
  UserLevel,
} from '../../shared/types';

export async function fetchHealth(): Promise<HealthInfo> {
  const res = await fetch('/api/health');
  if (!res.ok) {
    throw new Error(`Health check failed (${res.status})`);
  }
  return res.json() as Promise<HealthInfo>;
}

export async function fetchSettings(): Promise<PublicSettings> {
  const res = await fetch('/api/settings');
  const data = (await res.json()) as { settings?: PublicSettings; error?: string };
  if (!res.ok || !data.settings) {
    throw new Error(data.error || `Failed to load settings (${res.status})`);
  }
  return data.settings;
}

export async function saveSettings(
  payload: UpdateSettingsPayload
): Promise<{ settings: PublicSettings; health: HealthInfo }> {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as {
    settings?: PublicSettings;
    health?: HealthInfo;
    error?: string;
  };
  if (!res.ok || !data.settings || !data.health) {
    throw new Error(data.error || `Failed to save settings (${res.status})`);
  }
  return { settings: data.settings, health: data.health };
}

export async function testProviderConnection(
  payload: TestConnectionPayload
): Promise<TestConnectionResult> {
  const res = await fetch('/api/settings/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as Partial<TestConnectionResult> & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Connection test failed (${res.status})`);
  }
  return {
    ok: Boolean(data.ok),
    provider: data.provider ?? payload.provider,
    model: data.model ?? payload.model ?? '',
    latencyMs: data.latencyMs ?? 0,
    message: data.message ?? (data.ok ? 'Connected.' : 'Connection failed.'),
  };
}

export async function fetchCopilotModels(
  refresh = false,
  domain?: string
): Promise<CopilotModelsResponse> {
  const params = new URLSearchParams();
  if (refresh) params.set('refresh', 'true');
  if (domain?.trim()) params.set('domain', domain.trim());
  const query = params.toString();
  const res = await fetch(`/api/settings/copilot/models${query ? `?${query}` : ''}`);
  const data = (await res.json()) as Partial<CopilotModelsResponse> & { error?: string };
  if (!res.ok || !Array.isArray(data.models)) {
    throw new Error(data.error || `Failed to load Copilot models (${res.status})`);
  }
  return {
    models: data.models,
    source: data.source === 'live' ? 'live' : 'presets',
    error: data.error,
  };
}

export async function startCopilotDeviceFlow(
  domain?: string
): Promise<CopilotDeviceFlowStartResponse> {
  const res = await fetch('/api/settings/copilot/device/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: domain?.trim() || undefined }),
  });
  const data = (await res.json()) as Partial<CopilotDeviceFlowStartResponse> & { error?: string };
  if (!res.ok || !data.deviceCode || !data.userCode || !data.verificationUri) {
    throw new Error(data.error || `Failed to start GitHub Copilot sign-in (${res.status})`);
  }
  return data as CopilotDeviceFlowStartResponse;
}

export async function pollCopilotDeviceFlow(
  deviceCode: string,
  domain?: string
): Promise<CopilotDeviceFlowPollResponse> {
  const res = await fetch('/api/settings/copilot/device/poll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceCode, domain: domain?.trim() || undefined }),
  });
  const data = (await res.json()) as Partial<CopilotDeviceFlowPollResponse> & { error?: string };
  if (!res.ok || !data.status) {
    throw new Error(data.error || `Device sign-in check failed (${res.status})`);
  }
  return data as CopilotDeviceFlowPollResponse;
}

export async function browseDirectory(
  options?: {
    path?: string;
    showHidden?: boolean;
    fallback?: boolean;
  },
  signal?: AbortSignal
): Promise<DirectoryBrowseResponse> {
  const params = new URLSearchParams();
  if (options?.path) params.set('path', options.path);
  if (options?.showHidden) params.set('showHidden', 'true');
  if (options?.fallback) params.set('fallback', 'true');

  const query = params.toString();
  const res = await fetch(`/api/fs/browse${query ? `?${query}` : ''}`, { signal });
  const data = (await res.json()) as Partial<DirectoryBrowseResponse> & { error?: string };

  if (!res.ok || !data.currentPath) {
    throw new Error(data.error || `Failed to browse directory (${res.status})`);
  }
  return data as DirectoryBrowseResponse;
}

export async function fetchSessionsList(repoPath?: string): Promise<SessionsListResponse> {
  const params = new URLSearchParams();
  if (repoPath) params.set('repoPath', repoPath);
  const query = params.toString();
  const res = await fetch(`/api/sessions${query ? `?${query}` : ''}`);
  const data = (await res.json()) as Partial<SessionsListResponse> & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Failed to load sessions (${res.status})`);
  }
  return {
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    repoProgress: Array.isArray(data.repoProgress) ? data.repoProgress : [],
  };
}

export async function fetchSession(sessionId: string): Promise<SessionPublicState> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  const data = (await res.json()) as { session?: SessionPublicState; error?: string };
  if (!res.ok || !data.session) {
    throw new Error(data.error || `Session not found (${res.status})`);
  }
  return data.session;
}

export async function deleteSessionById(sessionId: string): Promise<SessionsListResponse> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
  const data = (await res.json()) as Partial<SessionsListResponse> & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Failed to delete session (${res.status})`);
  }
  return {
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    repoProgress: Array.isArray(data.repoProgress) ? data.repoProgress : [],
  };
}

export async function createSession(
  repoPath: string,
  provider?: ProviderSelection,
  options?: { startFresh?: boolean }
): Promise<SessionPublicState> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath, provider, startFresh: options?.startFresh }),
  });

  const data = (await res.json()) as { session?: SessionPublicState; error?: string };
  if (!res.ok || !data.session) {
    throw new Error(data.error || `Failed to start session (${res.status})`);
  }
  return data.session;
}

export async function streamSessionInit(
  repoPath: string,
  onEvent: (event: ScanSSEEvent) => void,
  provider?: ProviderSelection,
  options?: { startFresh?: boolean }
): Promise<SessionPublicState> {
  const res = await fetch('/api/sessions/stream-init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath, provider, startFresh: options?.startFresh }),
  });

  if (!res.ok || !res.body) {
    let errText = `Failed to initialize repository session (${res.status})`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) errText = json.error;
    } catch {
      // ignore
    }
    throw new Error(errText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completedSession: SessionPublicState | null = null;
  let streamError: string | null = null;

  const dispatchFrame = (rawFrame: string) => {
    const dataLines = rawFrame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());

    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n');
    try {
      const parsed = JSON.parse(payload) as ScanSSEEvent;
      onEvent(parsed);
      if (parsed.type === 'scan-complete') {
        completedSession = parsed.session;
      } else if (parsed.type === 'scan-error') {
        streamError = parsed.error;
      }
    } catch {
      // Ignore malformed frame
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      dispatchFrame(frame);
    }
  }

  buffer += decoder.decode().replace(/\r\n/g, '\n');
  if (buffer.trim()) {
    for (const frame of buffer.split('\n\n')) {
      dispatchFrame(frame);
    }
  }

  if (streamError) {
    throw new Error(streamError);
  }
  if (!completedSession) {
    return createSession(repoPath, provider, options);
  }
  return completedSession;
}

export async function checkSessionKnowledgeStatus(
  sessionId: string,
  autoRefresh = true
): Promise<{
  session: SessionPublicState;
  knowledgeStatus?: KnowledgeBaseStatus;
  refreshed: boolean;
  changedFilesCount: number;
  commitsBehind: number;
}> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/knowledge?autoRefresh=${autoRefresh ? 'true' : 'false'}`
  );
  const data = (await res.json()) as {
    session?: SessionPublicState;
    knowledgeStatus?: KnowledgeBaseStatus;
    refreshed?: boolean;
    changedFilesCount?: number;
    commitsBehind?: number;
    error?: string;
  };
  if (!res.ok || !data.session) {
    throw new Error(data.error || `Failed to check knowledge status (${res.status})`);
  }
  return {
    session: data.session,
    knowledgeStatus: data.knowledgeStatus,
    refreshed: Boolean(data.refreshed),
    changedFilesCount: data.changedFilesCount ?? 0,
    commitsBehind: data.commitsBehind ?? 0,
  };
}

export async function refreshSessionKnowledge(
  sessionId: string,
  mode: 'full' | 'incremental' = 'full'
): Promise<{
  session: SessionPublicState;
  knowledgeStatus?: KnowledgeBaseStatus;
  refreshed: boolean;
  changedFilesCount: number;
}> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/knowledge/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  const data = (await res.json()) as {
    session?: SessionPublicState;
    knowledgeStatus?: KnowledgeBaseStatus;
    refreshed?: boolean;
    changedFilesCount?: number;
    error?: string;
  };
  if (!res.ok || !data.session) {
    throw new Error(data.error || `Failed to refresh knowledge base (${res.status})`);
  }
  return {
    session: data.session,
    knowledgeStatus: data.knowledgeStatus,
    refreshed: Boolean(data.refreshed),
    changedFilesCount: data.changedFilesCount ?? 0,
  };
}

export async function patchSession(
  sessionId: string,
  patch: {
    inferredLevel?: UserLevel;
    currentStage?: OnboardingStage;
    provider?: ProviderSelection;
  }
): Promise<SessionPublicState> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });

  const data = (await res.json()) as { session?: SessionPublicState; error?: string };
  if (!res.ok || !data.session) {
    throw new Error(data.error || `Failed to update session (${res.status})`);
  }
  return data.session;
}

export async function renderD2Diagram(
  source: string
): Promise<{ ok: boolean; svg?: string; error?: string }> {
  const res = await fetch('/api/render/d2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  return res.json() as Promise<{ ok: boolean; svg?: string; error?: string }>;
}

export async function fetchCodePeekFile(
  sessionId: string,
  options: {
    path: string;
    startLine?: number;
    endLine?: number;
  }
): Promise<CodePeekFileResponse> {
  const params = new URLSearchParams();
  params.set('path', options.path);
  if (options.startLine !== undefined) params.set('startLine', String(options.startLine));
  if (options.endLine !== undefined) params.set('endLine', String(options.endLine));

  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/peek/file?${params.toString()}`
  );
  const data = (await res.json()) as Partial<CodePeekFileResponse> & { error?: string };
  if (!res.ok || !data.path) {
    throw new Error(data.error || `Failed to inspect file (${res.status})`);
  }
  return data as CodePeekFileResponse;
}

export async function fetchCodePeekGit(
  sessionId: string,
  options: {
    subcommand: 'show' | 'blame' | 'log';
    target?: string;
    startLine?: number;
    endLine?: number;
  }
): Promise<CodePeekGitResponse> {
  const params = new URLSearchParams();
  params.set('subcommand', options.subcommand);
  if (options.target) params.set('target', options.target);
  if (options.startLine !== undefined) params.set('startLine', String(options.startLine));
  if (options.endLine !== undefined) params.set('endLine', String(options.endLine));

  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/peek/git?${params.toString()}`
  );
  const data = (await res.json()) as Partial<CodePeekGitResponse> & { error?: string };
  if (!res.ok || data.output === undefined) {
    throw new Error(data.error || `Failed to inspect git history (${res.status})`);
  }
  return data as CodePeekGitResponse;
}

export async function fetchKnowledgeGraph(
  sessionId: string
): Promise<KnowledgeGraphResponse> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/knowledge/graph`
  );
  const data = (await res.json()) as Partial<KnowledgeGraphResponse> & { error?: string };
  if (!res.ok || !Array.isArray(data.modules)) {
    throw new Error(data.error || `Failed to load architecture graph (${res.status})`);
  }
  return data as KnowledgeGraphResponse;
}

export async function exportSessionHandbook(
  sessionId: string,
  format: HandbookExportFormat = 'html'
): Promise<HandbookExportResponse> {
  const params = new URLSearchParams();
  params.set('format', format);
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/export?${params.toString()}`
  );
  const data = (await res.json()) as Partial<HandbookExportResponse> & { error?: string };
  if (!res.ok || !data.content || !data.filename) {
    throw new Error(data.error || `Failed to export onboarding handbook (${res.status})`);
  }
  return data as HandbookExportResponse;
}

export async function streamChatTurn(
  sessionId: string,
  message: string,
  onEvent: (event: SSEEvent) => void,
  provider?: ProviderSelection
): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, provider }),
  });

  if (!res.ok || !res.body) {
    let errText = `Chat request failed (${res.status})`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) errText = json.error;
    } catch {
      // ignore
    }
    throw new Error(errText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatchFrame = (rawFrame: string) => {
    const dataLines = rawFrame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());

    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n');
    try {
      const parsed = JSON.parse(payload) as SSEEvent;
      onEvent(parsed);
    } catch {
      // Ignore malformed partial frame
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      dispatchFrame(frame);
    }
  }

  buffer += decoder.decode().replace(/\r\n/g, '\n');
  if (buffer.trim()) {
    for (const frame of buffer.split('\n\n')) {
      dispatchFrame(frame);
    }
  }
}
