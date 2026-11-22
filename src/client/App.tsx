import { useEffect, useState } from 'react';
import type {
  ChatMessage,
  HealthInfo,
  ProviderSelection,
  SessionPublicState,
  ToolActivity,
  UserLevel,
  VisualArtifact,
} from '../shared/types';
import { createSession, fetchHealth, patchSession, streamChatTurn } from './api/client';
import { ChatMessageList } from './components/ChatMessageList';
import { Composer } from './components/Composer';
import { RepoWelcome } from './components/RepoWelcome';
import { SettingsModal } from './components/SettingsModal';
import { StageProgressBar } from './components/StageProgressBar';

export function App() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [provider, setProvider] = useState<ProviderSelection>({
    provider: 'demo',
    model: 'local-grounded-demo',
  });
  const [session, setSession] = useState<SessionPublicState | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingActivities, setStreamingActivities] = useState<ToolActivity[]>([]);
  const [streamingVisuals, setStreamingVisuals] = useState<VisualArtifact[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    fetchHealth()
      .then((info) => {
        setHealth(info);
        setProvider({
          provider: info.defaultProvider,
          model: info.defaultModel,
        });
      })
      .catch(() => {
        // Server may still be starting during dev
      });
  }, []);

  async function handleStartSession(repoPath: string) {
    setInitializing(true);
    setInitError(null);
    setChatError(null);
    try {
      const created = await createSession(repoPath, provider);
      setSession(created);
    } catch (err) {
      setInitError(err instanceof Error ? err.message : 'Failed to open repository.');
    } finally {
      setInitializing(false);
    }
  }

  async function handleSend(text: string) {
    if (!session || isStreaming) return;

    setChatError(null);
    const optimisticUser: ChatMessage = {
      id: `local_${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      stage: session.currentStage,
    };

    setSession((prev) =>
      prev ? { ...prev, messages: [...prev.messages, optimisticUser] } : prev
    );
    setIsStreaming(true);
    setStreamingText('');
    setStreamingActivities([]);
    setStreamingVisuals([]);

    try {
      await streamChatTurn(
        session.id,
        text,
        (event) => {
          if (event.type === 'text-delta') {
            setStreamingText((prev) => prev + event.delta);
          } else if (event.type === 'tool-activity') {
            setStreamingActivities((prev) => {
              const idx = prev.findIndex((a) => a.id === event.activity.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = event.activity;
                return next;
              }
              return [...prev, event.activity];
            });
          } else if (event.type === 'visual') {
            setStreamingVisuals((prev) => [...prev, event.visual]);
          } else if (event.type === 'session-state') {
            setSession((prev) =>
              prev
                ? {
                    ...prev,
                    currentStage: event.currentStage,
                    completedStages: event.completedStages,
                    diagnostic: event.diagnostic,
                    observedFilesCount: event.observedFilesCount,
                    observedCommitsCount: event.observedCommitsCount,
                  }
                : prev
            );
          } else if (event.type === 'done') {
            setSession((prev) =>
              prev ? { ...prev, messages: [...prev.messages, event.message] } : prev
            );
          } else if (event.type === 'error') {
            setChatError(event.error);
          }
        },
        provider
      );
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Chat stream failed.');
    } finally {
      setIsStreaming(false);
      setStreamingText('');
      setStreamingActivities([]);
      setStreamingVisuals([]);
    }
  }

  async function handleChangeLevel(level: UserLevel) {
    if (!session) return;
    try {
      const updated = await patchSession(session.id, { inferredLevel: level });
      setSession(updated);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Failed to update depth calibration.');
    }
  }

  async function handleSaveProvider(next: ProviderSelection) {
    setProvider(next);
    if (session) {
      try {
        const updated = await patchSession(session.id, { provider: next });
        setSession(updated);
      } catch {
        // Provider will still be passed per chat request
      }
    }
  }

  return (
    <div className="app-shell">
      {!session ? (
        <RepoWelcome
          health={health}
          provider={provider}
          loading={initializing}
          error={initError}
          onStartSession={handleStartSession}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <>
          <StageProgressBar
            session={session}
            onChangeLevel={handleChangeLevel}
            onOpenSettings={() => setSettingsOpen(true)}
            onResetSession={() => {
              setSession(null);
              setChatError(null);
            }}
          />

          <ChatMessageList
            messages={session.messages}
            streamingText={streamingText}
            streamingActivities={streamingActivities}
            streamingVisuals={streamingVisuals}
            isStreaming={isStreaming}
          />

          {chatError && (
            <div style={{ maxWidth: 780, width: '100%', margin: '0 auto 6px', padding: '0 20px' }}>
              <div className="error-banner" style={{ marginTop: 0 }}>
                {chatError}
              </div>
            </div>
          )}

          <Composer
            currentStage={session.currentStage}
            provider={provider}
            observedFilesCount={session.observedFilesCount}
            observedCommitsCount={session.observedCommitsCount}
            disabled={isStreaming}
            onSend={handleSend}
          />
        </>
      )}

      {settingsOpen && (
        <SettingsModal
          health={health}
          provider={provider}
          onSave={handleSaveProvider}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
