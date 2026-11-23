import { useEffect, useState } from 'react';
import type {
  ChatMessage,
  CorePillarId,
  HealthInfo,
  LearningTopic,
  ProviderSelection,
  SessionPublicState,
  ToolActivity,
  UserLevel,
  VisualArtifact,
} from '../shared/types';
import {
  checkSessionKnowledgeStatus,
  fetchHealth,
  patchSession,
  refreshSessionKnowledge,
  streamChatTurn,
  streamSessionInit,
} from './api/client';
import { ChatMessageList } from './components/ChatMessageList';
import { Composer } from './components/Composer';
import { RepoWelcome } from './components/RepoWelcome';
import type { ScanProgressState } from './components/RepoWelcome';
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
  const [scanProgress, setScanProgress] = useState<ScanProgressState | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingActivities, setStreamingActivities] = useState<ToolActivity[]>([]);
  const [streamingVisuals, setStreamingVisuals] = useState<VisualArtifact[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);

  const [refreshingKnowledge, setRefreshingKnowledge] = useState(false);
  const [knowledgeToast, setKnowledgeToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    fetchHealth()
      .then((info) => {
        setHealth(info);
        setProvider({
          provider: info.defaultProvider,
          model: info.defaultModel,
          baseUrl: info.defaultBaseUrl,
        });
      })
      .catch(() => {
        // Server may still be starting during dev
      });
  }, []);

  // Automatically check if git pull updated local repo HEAD on window focus or periodic poll
  useEffect(() => {
    if (!session || isStreaming || refreshingKnowledge) return;

    const checkGitPullUpdate = async () => {
      try {
        const res = await checkSessionKnowledgeStatus(session.id, true);
        if (res.refreshed) {
          setSession(res.session);
          setKnowledgeToast(
            `Detected git update — Knowledge Map auto-refreshed (${res.changedFilesCount} file${res.changedFilesCount === 1 ? '' : 's'} updated).`
          );
        }
      } catch {
        // Ignore background check errors
      }
    };

    const onFocus = () => {
      void checkGitPullUpdate();
    };
    window.addEventListener('focus', onFocus);
    const interval = window.setInterval(() => {
      void checkGitPullUpdate();
    }, 25_000);

    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(interval);
    };
  }, [session?.id, isStreaming, refreshingKnowledge]);

  useEffect(() => {
    if (!knowledgeToast) return;
    const timer = window.setTimeout(() => setKnowledgeToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [knowledgeToast]);

  async function handleStartSession(repoPath: string) {
    setInitializing(true);
    setInitError(null);
    setChatError(null);
    setScanProgress({
      phase: 'recon',
      message: 'Starting repository scanner agent…',
      percent: 5,
    });
    try {
      const created = await streamSessionInit(
        repoPath,
        (event) => {
          if (event.type === 'scan-progress') {
            setScanProgress({
              phase: event.phase,
              message: event.message,
              percent: event.percent,
              filesProcessed: event.filesProcessed,
              totalFiles: event.totalFiles,
            });
          }
        },
        provider
      );
      setSession(created);
    } catch (err) {
      setInitError(err instanceof Error ? err.message : 'Failed to open repository.');
    } finally {
      setInitializing(false);
      setScanProgress(null);
    }
  }

  async function handleRefreshKnowledge(mode: 'full' | 'incremental' = 'full') {
    if (!session || refreshingKnowledge) return;
    setRefreshingKnowledge(true);
    try {
      const res = await refreshSessionKnowledge(session.id, mode);
      setSession(res.session);
      setKnowledgeToast(
        `Knowledge Map refreshed (${res.session.knowledgeStatus?.stats?.indexedFiles ?? 0} files, ${res.session.knowledgeStatus?.stats?.totalModules ?? 0} modules indexed).`
      );
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Failed to refresh Knowledge Map.');
    } finally {
      setRefreshingKnowledge(false);
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
      topicTitle: session.learning.activeTopicTitle,
    };

    setSession((prev) =>
      prev ? { ...prev, messages: [...prev.messages, optimisticUser] } : prev
    );
    setIsStreaming(true);
    setStreamingText('');
    setStreamingActivities([]);
    setStreamingVisuals([]);

    let receivedDone = false;
    let accText = '';
    let accStage = session.currentStage;
    let accTopicTitle = session.learning.activeTopicTitle;
    const accActivities: ToolActivity[] = [];
    const accVisuals: VisualArtifact[] = [];

    try {
      await streamChatTurn(
        session.id,
        text,
        (event) => {
          if (event.type === 'text-delta') {
            accText += event.delta;
            setStreamingText(accText);
          } else if (event.type === 'tool-activity') {
            const idx = accActivities.findIndex((a) => a.id === event.activity.id);
            if (idx >= 0) accActivities[idx] = event.activity;
            else accActivities.push(event.activity);
            setStreamingActivities([...accActivities]);
          } else if (event.type === 'visual') {
            accVisuals.push(event.visual);
            setStreamingVisuals([...accVisuals]);
          } else if (event.type === 'session-state') {
            accStage = event.currentStage;
            accTopicTitle = event.learning.activeTopicTitle;
            setSession((prev) =>
              prev
                ? {
                    ...prev,
                    currentStage: event.currentStage,
                    completedStages: event.completedStages,
                    diagnostic: event.diagnostic,
                    learning: event.learning,
                    knowledgeStatus: event.knowledgeStatus ?? prev.knowledgeStatus,
                    observedFilesCount: event.observedFilesCount,
                    observedCommitsCount: event.observedCommitsCount,
                  }
                : prev
            );
          } else if (event.type === 'done') {
            receivedDone = true;
            setSession((prev) =>
              prev ? { ...prev, messages: [...prev.messages, event.message] } : prev
            );
          } else if (event.type === 'error') {
            setChatError(event.error);
          }
        },
        provider
      );

      // Defensive fallback: never discard already-streamed content if stream closed without `done`
      if (!receivedDone && (accText.trim() || accVisuals.length > 0)) {
        const fallbackMessage: ChatMessage = {
          id: `msg_fallback_${Date.now()}`,
          role: 'assistant',
          content: accText.trim() || '(Visual response)',
          createdAt: new Date().toISOString(),
          stage: accStage,
          topicTitle: accTopicTitle,
          visuals: accVisuals.length > 0 ? [...accVisuals] : undefined,
          toolActivities: accActivities.length > 0 ? [...accActivities] : undefined,
        };
        setSession((prev) =>
          prev ? { ...prev, messages: [...prev.messages, fallbackMessage] } : prev
        );
      }
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Chat stream failed.');
    } finally {
      setIsStreaming(false);
      setStreamingText('');
      setStreamingActivities([]);
      setStreamingVisuals([]);
    }
  }

  function handleSelectPillar(_pillarId: CorePillarId, title: string) {
    void handleSend(`Let's explore ${title}.`);
  }

  function handleSelectTopic(topic: LearningTopic) {
    if (topic.kind === 'custom') {
      void handleSend(`Let's revisit and deepen "${topic.title}".`);
    } else {
      void handleSend(`Let's explore ${topic.title}.`);
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

  async function handleSettingsSaved(next: ProviderSelection, nextHealth: HealthInfo) {
    setHealth(nextHealth);
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
          scanProgress={scanProgress}
          error={initError}
          onStartSession={handleStartSession}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <>
          <StageProgressBar
            session={session}
            disabled={isStreaming}
            refreshingKnowledge={refreshingKnowledge}
            onSelectPillar={handleSelectPillar}
            onSelectTopic={handleSelectTopic}
            onSelectModule={(modId) => void handleSend(`Teach me how the \`${modId}\` module works and how it connects to the rest of the repo.`)}
            onRefreshKnowledge={() => void handleRefreshKnowledge('full')}
            onChangeLevel={handleChangeLevel}
            onOpenSettings={() => setSettingsOpen(true)}
            onResetSession={() => {
              setSession(null);
              setChatError(null);
              setKnowledgeToast(null);
            }}
          />

          {knowledgeToast && (
            <div className="knowledge-toast-banner" role="status">
              <span>{knowledgeToast}</span>
            </div>
          )}

          <ChatMessageList
            messages={session.messages}
            activeTopicTitle={session.learning.activeTopicTitle}
            streamingText={streamingText}
            streamingActivities={streamingActivities}
            streamingVisuals={streamingVisuals}
            isStreaming={isStreaming}
            onSelectPrompt={(prompt) => void handleSend(prompt)}
          />

          {chatError && (
            <div style={{ maxWidth: 780, width: '100%', margin: '0 auto 6px', padding: '0 20px' }}>
              <div className="error-banner" style={{ marginTop: 0 }}>
                {chatError}
              </div>
            </div>
          )}

          <Composer
            diagnostic={session.diagnostic}
            activeTopicTitle={session.learning.activeTopicTitle}
            hasPendingCheckIn={session.learning.pendingCheckIn.length > 0}
            provider={provider}
            observedFilesCount={session.observedFilesCount}
            observedCommitsCount={session.observedCommitsCount}
            disabled={isStreaming}
            onSend={(prompt) => void handleSend(prompt)}
          />
        </>
      )}

      {settingsOpen && (
        <SettingsModal
          health={health}
          provider={provider}
          onSaved={handleSettingsSaved}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
