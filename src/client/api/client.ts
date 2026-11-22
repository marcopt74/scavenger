import type {
  DirectoryBrowseResponse,
  HealthInfo,
  OnboardingStage,
  ProviderSelection,
  SSEEvent,
  SessionPublicState,
  UserLevel,
} from '../../shared/types';

export async function fetchHealth(): Promise<HealthInfo> {
  const res = await fetch('/api/health');
  if (!res.ok) {
    throw new Error(`Health check failed (${res.status})`);
  }
  return res.json() as Promise<HealthInfo>;
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

export async function createSession(
  repoPath: string,
  provider?: ProviderSelection
): Promise<SessionPublicState> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath, provider }),
  });

  const data = (await res.json()) as { session?: SessionPublicState; error?: string };
  if (!res.ok || !data.session) {
    throw new Error(data.error || `Failed to start session (${res.status})`);
  }
  return data.session;
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
