import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ChatMessage,
  CodePeekTarget,
  CorePillarId,
  HandbookExportFormat,
  HealthInfo,
  LearningTopic,
  ProviderSelection,
  RepoProgressSummary,
  SessionPublicState,
  SessionSummary,
  ToolActivity,
  UserLevel,
  VisualArtifact,
} from '../shared/types';
import {
  checkSessionKnowledgeStatus,
  deleteSessionById,
  exportSessionHandbook,
  fetchHealth,
  fetchSession,
  fetchSessionsList,
  patchSession,
  refreshSessionKnowledge,
  streamChatTurn,
  streamSessionInit,
} from './api/client';
import { ArchitectureGraphModal } from './components/ArchitectureGraphModal';
import { ChatMessageList } from './components/ChatMessageList';
import { CodePeekDrawer } from './components/CodePeekDrawer';
import { Composer } from './components/Composer';
import { LeftToolbar } from './components/LeftToolbar';
import { RepoWelcome } from './components/RepoWelcome';
import type { ScanProgressState } from './components/RepoWelcome';
import { SessionsProgressModal } from './components/SessionsProgressModal';
import { SettingsModal } from './components/SettingsModal';
import { StageProgressBar } from './components/StageProgressBar';
import {
  applyDocumentTheme,
  readStoredTheme,
  toggleThemeMode,
  writeStoredTheme,
} from './utils/theme';
import type { ThemeMode } from './utils/theme';

const ACTIVE_SESSION_STORAGE_KEY = 'scavenger.activeSessionId';

function readStoredSessionId(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('session')?.trim();
    if (fromUrl) return fromUrl;
    const fromStorage = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)?.trim();
    return fromStorage || null;
  } catch {
    return null;
  }
}

function writeStoredSessionId(sessionId: string | null): void {
  try {
    const url = new URL(window.location.href);
    if (sessionId) {
      window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
      url.searchParams.set('session', sessionId);
    } else {
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
      url.searchParams.delete('session');
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Ignore storage/history errors in restricted environments
  }
}

export function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [provider, setProvider] = useState<ProviderSelection>({
    provider: 'demo',
    model: 'local-grounded-demo',
  });
  const [session, setSession] = useState<SessionPublicState | null>(null);
  const [restoringSession, setRestoringSession] = useState<boolean>(() => Boolean(readStoredSessionId()));
  const [sessionsList, setSessionsList] = useState<SessionSummary[]>([]);
  const [repoProgressList, setRepoProgressList] = useState<RepoProgressSummary[]>([]);
  const [initializing, setInitializing] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgressState | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingActivities, setStreamingActivities] = useState<ToolActivity[]>([]);
  const [streamingVisuals, setStreamingVisuals] = useState<VisualArtifact[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);

  const [refreshingKnowledge, setRefreshingKnowledge] = useState(false);
  const [exportingHandbook, setExportingHandbook] = useState(false);
  const [knowledgeToast, setKnowledgeToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [progressModalOpen, setProgressModalOpen] = useState(false);
  const [graphStudioOpen, setGraphStudioOpen] = useState(false);
  const [codePeekTarget, setCodePeekTarget] = useState<CodePeekTarget | null>(null);

  useEffect(() => {
    applyDocumentTheme(theme);
    writeStoredTheme(theme);
  }, [theme]);

  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => toggleThemeMode(prev));
  }, []);

  const refreshSessionsCatalog = useCallback(async () => {
    try {
      const res = await fetchSessionsList();
      setSessionsList(res.sessions);
      setRepoProgressList(res.repoProgress);
    } catch {
      // Ignore background catalog refresh errors
    }
  }, []);

  useEffect(() => {
    fetchHealth()
      .then((info) => {
        setHealth(info);
        setProvider((prev) =>
          session
            ? prev
            : {
                provider: info.defaultProvider,
                model: info.defaultModel,
                baseUrl: info.defaultBaseUrl,
              }
        );
      })
      .catch(() => {
        // Server may still be starting during dev
      });

    void refreshSessionsCatalog();

    const savedSessionId = readStoredSessionId();
    if (savedSessionId) {
      setRestoringSession(true);
      fetchSession(savedSessionId)
        .then((restored) => {
          setSession(restored);
          setProvider(restored.provider);
          writeStoredSessionId(restored.id);
        })
        .catch(() => {
          writeStoredSessionId(null);
        })
        .finally(() => {
          setRestoringSession(false);
        });
    }
    // Run once on initial mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const targetId = readStoredSessionId();
      if (!targetId) {
        setSession(null);
        return;
      }
      if (targetId !== session?.id) {
        void handleResumeSession(targetId);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  });

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

  async function handleStartSession(repoPath: string, options?: { startFresh?: boolean }) {
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
        provider,
        options
      );
      setSession(created);
      writeStoredSessionId(created.id);
      void refreshSessionsCatalog();
    } catch (err) {
      setInitError(err instanceof Error ? err.message : 'Failed to open repository.');
    } finally {
      setInitializing(false);
      setScanProgress(null);
    }
  }

  async function handleResumeSession(sessionId: string) {
    setInitError(null);
    setChatError(null);
    setRestoringSession(true);
    try {
      const loaded = await fetchSession(sessionId);
      setSession(loaded);
      setProvider(loaded.provider);
      writeStoredSessionId(loaded.id);
      void refreshSessionsCatalog();
    } catch (err) {
      setInitError(err instanceof Error ? err.message : 'Failed to resume session.');
    } finally {
      setRestoringSession(false);
    }
  }

  async function handleDeleteSession(sessionId: string) {
    try {
      const res = await deleteSessionById(sessionId);
      setSessionsList(res.sessions);
      setRepoProgressList(res.repoProgress);
      if (session?.id === sessionId) {
        setSession(null);
        writeStoredSessionId(null);
      }
    } catch (err) {
      setInitError(err instanceof Error ? err.message : 'Failed to delete session.');
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

  async function handleExportHandbook(format: HandbookExportFormat = 'html') {
    if (!session || exportingHandbook) return;
    setExportingHandbook(true);
    try {
      const exported = await exportSessionHandbook(session.id, format);
      const blob = new Blob([exported.content], { type: exported.mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exported.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setKnowledgeToast(`Exported Onboarding Handbook: ${exported.filename}`);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Failed to export onboarding handbook.');
    } finally {
      setExportingHandbook(false);
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
      void refreshSessionsCatalog();
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
      void refreshSessionsCatalog();
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

  const currentRepoProgress = session
    ? repoProgressList.find((r) => r.repoPath === session.repoPath)
    : undefined;

  const knownFiles = useMemo(() => {
    if (!session) return [];
    const set = new Set<string>();
    for (const topic of session.learning.topics) {
      for (const f of topic.relatedFiles ?? []) set.add(f);
    }
    for (const ep of session.knowledgeStatus?.entryPoints ?? []) {
      set.add(ep.path);
    }
    for (const flow of session.knowledgeStatus?.coreFlows ?? []) {
      for (const f of flow.files) set.add(f);
    }
    for (const m of session.rootRecon.manifests ?? []) {
      set.add(m.path);
    }
    if (session.rootRecon.readmePath) {
      set.add(session.rootRecon.readmePath);
    }
    return [...set];
  }, [session]);

  return (
    <div className="app-shell">
      {!session ? (
        <RepoWelcome
          health={health}
          provider={provider}
          loading={initializing}
          restoringSession={restoringSession}
          scanProgress={scanProgress}
          error={initError}
          sessions={sessionsList}
          repoProgress={repoProgressList}
          onStartSession={(repoPath, options) => void handleStartSession(repoPath, options)}
          onResumeSession={(sessionId) => void handleResumeSession(sessionId)}
          onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
          onOpenProgressModal={() => setProgressModalOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          theme={theme}
          onToggleTheme={handleToggleTheme}
        />
      ) : (
        <>
          <StageProgressBar
            session={session}
            disabled={isStreaming}
            exportingHandbook={exportingHandbook}
            onSelectPillar={handleSelectPillar}
            onOpenGraphStudio={() => setGraphStudioOpen(true)}
            onExportHandbook={(format) => void handleExportHandbook(format)}
            onOpenSettings={() => setSettingsOpen(true)}
            theme={theme}
            onToggleTheme={handleToggleTheme}
            onResetSession={() => {
              setSession(null);
              setCodePeekTarget(null);
              setGraphStudioOpen(false);
              writeStoredSessionId(null);
              setChatError(null);
              setKnowledgeToast(null);
              void refreshSessionsCatalog();
            }}
          />

          <div className="session-workspace">
            <LeftToolbar
              session={session}
              disabled={isStreaming}
              refreshingKnowledge={refreshingKnowledge}
              exportingHandbook={exportingHandbook}
              currentRepoProgress={currentRepoProgress}
              totalSessionsCount={sessionsList.length}
              onSelectTopic={handleSelectTopic}
              onSelectModule={(modId) =>
                void handleSend(
                  `Teach me how the \`${modId}\` module works and how it connects to the rest of the repo.`
                )
              }
              onRefreshKnowledge={() => void handleRefreshKnowledge('full')}
              onOpenGraphStudio={() => setGraphStudioOpen(true)}
              onExportHandbook={(format) => void handleExportHandbook(format)}
              onChangeLevel={handleChangeLevel}
              onOpenProgressModal={() => {
                void refreshSessionsCatalog();
                setProgressModalOpen(true);
              }}
            />

            <div className="session-main">
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
                onOpenCodePeek={(target) => setCodePeekTarget(target)}
                knownFiles={knownFiles}
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
                streamingText={streamingText}
                streamingActivities={streamingActivities}
                streamingVisuals={streamingVisuals}
                onSend={(prompt) => void handleSend(prompt)}
              />
            </div>

            <CodePeekDrawer
              sessionId={session.id}
              target={codePeekTarget}
              disabled={isStreaming}
              onClose={() => setCodePeekTarget(null)}
              onSelectTarget={(nextTarget) => setCodePeekTarget(nextTarget)}
              onAskScavenger={(prompt) => {
                setCodePeekTarget(null);
                void handleSend(prompt);
              }}
            />
          </div>

          {graphStudioOpen && (
            <ArchitectureGraphModal
              session={session}
              disabled={isStreaming}
              onClose={() => setGraphStudioOpen(false)}
              onSelectModuleToLearn={(_moduleId, prompt) => {
                setGraphStudioOpen(false);
                void handleSend(prompt);
              }}
              onOpenFilePeek={(target) => {
                setGraphStudioOpen(false);
                setCodePeekTarget(target);
              }}
            />
          )}
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

      {progressModalOpen && (
        <SessionsProgressModal
          activeSessionId={session?.id}
          activeRepoPath={session?.repoPath}
          sessions={sessionsList}
          repoProgress={repoProgressList}
          loading={initializing || restoringSession}
          onResumeSession={(sessionId) => void handleResumeSession(sessionId)}
          onStartRepoSession={(repoPath, options) => void handleStartSession(repoPath, options)}
          onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
          onClose={() => setProgressModalOpen(false)}
        />
      )}
    </div>
  );
}
