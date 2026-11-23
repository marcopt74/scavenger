import crypto from 'node:crypto';
import { stepCountIs, streamText } from 'ai';
import type {
  ChatMessage,
  CheckInQuestion,
  ProviderSelection,
  SSEEvent,
  SuggestedNextStep,
  ToolActivity,
  VisualArtifact,
} from '../../shared/types.js';
import { resolveLanguageModel } from '../config.js';
import { getRepoGitState } from '../knowledge/gitWatcher.js';
import { scanOrRefreshRepoKnowledge } from '../knowledge/scannerAgent.js';
import { cloneLearningState } from '../session/learningEngine.js';
import { updateSessionKnowledge } from '../session/sessionStore.js';
import type { InternalSession } from '../session/sessionStore.js';
import { detectRecalibrationSignal } from '../session/stageMachine.js';
import { createAgentTools } from '../tools/agentTools.js';
import { checkD2Available } from '../tools/visualTools.js';
import { runDemoTurn } from './demoAgent.js';
import { buildSystemPrompt } from './systemPrompt.js';

export async function runOnboardingTurn(
  session: InternalSession,
  userText: string,
  emit: (event: SSEEvent) => void,
  providerOverride?: ProviderSelection
): Promise<ChatMessage> {
  const userMessage: ChatMessage = {
    id: `msg_${crypto.randomUUID().slice(0, 8)}`,
    role: 'user',
    content: userText,
    createdAt: new Date().toISOString(),
    stage: session.currentStage,
    topicTitle: session.learning.activeTopicTitle,
  };
  session.messages.push(userMessage);

  // Immediately honor explicit level recalibration requests from user text
  const recalibrated = detectRecalibrationSignal(userText, session.diagnostic.inferredLevel);
  if (recalibrated) {
    session.diagnostic.inferredLevel = recalibrated;
    session.diagnostic.completed = true;
    emit({
      type: 'session-state',
      currentStage: session.currentStage,
      completedStages: [...session.completedStages].sort((a, b) => a - b),
      diagnostic: { ...session.diagnostic },
      learning: cloneLearningState(session.learning),
      knowledgeStatus: session.knowledgeStatus ? { ...session.knowledgeStatus } : undefined,
      observedFilesCount: session.observedFiles.size,
      observedCommitsCount: session.observedCommits.size,
    });
  }

  const activeProvider = providerOverride ?? session.provider;
  const visuals: VisualArtifact[] = [];
  const toolActivities: ToolActivity[] = [];
  let turnCheckInQuestions: CheckInQuestion[] | undefined;
  let turnSuggestedNextSteps: SuggestedNextStep[] | undefined;

  const recordVisual = (v: VisualArtifact) => visuals.push(v);
  const recordActivity = (a: ToolActivity) => {
    const idx = toolActivities.findIndex((existing) => existing.id === a.id);
    if (idx >= 0) toolActivities[idx] = a;
    else toolActivities.push(a);
  };

  // Auto-detect git pull / HEAD updates before turn execution and incrementally refresh Knowledge Map
  await ensureSessionKnowledgeFreshBeforeTurn(session, activeProvider, {
    emit,
    recordActivity,
  });
  const recordLessonFooter = (footer: {
    checkInQuestions?: CheckInQuestion[];
    suggestedNextSteps?: SuggestedNextStep[];
  }) => {
    if (footer.checkInQuestions !== undefined) {
      turnCheckInQuestions = footer.checkInQuestions;
    }
    if (footer.suggestedNextSteps !== undefined) {
      turnSuggestedNextSteps = footer.suggestedNextSteps;
    }
  };

  let fullText = '';

  try {
    const model = resolveLanguageModel(activeProvider);

    if (!model) {
      fullText = await runDemoTurn(session, userText, {
        emit,
        recordVisual,
        recordActivity,
        recordLessonFooter,
        recalibrated,
      });
    } else {
      const d2Available = await checkD2Available();
      const tools = createAgentTools(session, {
        emit,
        recordVisual,
        recordActivity,
        recordLessonFooter,
      });

      const system = buildSystemPrompt(session, { d2Available });
      const conversation = session.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const result = streamText({
        model,
        system,
        messages: conversation,
        tools,
        stopWhen: stepCountIs(14),
        temperature: 0.5,
      });

      for await (const delta of result.textStream) {
        if (delta) {
          fullText += delta;
          emit({ type: 'text-delta', delta });
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected agent error.';
    emit({ type: 'error', error: message });
    throw err;
  }

  const assistantMessage: ChatMessage = {
    id: `msg_${crypto.randomUUID().slice(0, 8)}`,
    role: 'assistant',
    content: fullText.trim() || '(No response text generated.)',
    createdAt: new Date().toISOString(),
    stage: session.currentStage,
    topicTitle: session.learning.activeTopicTitle,
    visuals: visuals.length > 0 ? visuals : undefined,
    toolActivities: toolActivities.length > 0 ? toolActivities : undefined,
    checkInQuestions:
      turnCheckInQuestions && turnCheckInQuestions.length > 0 ? turnCheckInQuestions : undefined,
    suggestedNextSteps:
      turnSuggestedNextSteps && turnSuggestedNextSteps.length > 0
        ? turnSuggestedNextSteps
        : undefined,
  };

  session.messages.push(assistantMessage);
  session.updatedAt = new Date().toISOString();

  emit({
    type: 'session-state',
    currentStage: session.currentStage,
    completedStages: [...session.completedStages].sort((a, b) => a - b),
    diagnostic: { ...session.diagnostic },
    learning: cloneLearningState(session.learning),
    knowledgeStatus: session.knowledgeStatus ? { ...session.knowledgeStatus } : undefined,
    observedFilesCount: session.observedFiles.size,
    observedCommitsCount: session.observedCommits.size,
  });
  emit({ type: 'done', message: assistantMessage });

  return assistantMessage;
}

async function ensureSessionKnowledgeFreshBeforeTurn(
  session: InternalSession,
  provider: ProviderSelection,
  callbacks: {
    emit: (event: SSEEvent) => void;
    recordActivity: (activity: ToolActivity) => void;
  }
): Promise<void> {
  try {
    if (!session.knowledgeMap) {
      const scanned = await scanOrRefreshRepoKnowledge(session.repoPath, {
        recon: session.rootRecon,
        provider,
        skipLlmSynthesis: provider.provider === 'demo',
      });
      updateSessionKnowledge(session, scanned.knowledgeMap, scanned.status);
      return;
    }

    if (!session.rootRecon.isGitRepo || !session.knowledgeMap.headCommit) {
      return;
    }

    const gitState = await getRepoGitState(session.repoPath);
    if (!gitState.headCommit || gitState.headCommit === session.knowledgeMap.headCommit) {
      return;
    }

    const oldShort = session.knowledgeMap.headCommit.slice(0, 7);
    const newShort = gitState.headCommit.slice(0, 7);
    const actId = `act_${crypto.randomUUID().slice(0, 8)}`;
    const running: ToolActivity = {
      id: actId,
      toolName: 'refresh_knowledge_map',
      summary: `Detected git update (${oldShort} → ${newShort}) — incrementally refreshing Knowledge Map…`,
      target: newShort,
      status: 'running',
    };
    callbacks.emit({ type: 'tool-activity', activity: running });

    const refreshed = await scanOrRefreshRepoKnowledge(session.repoPath, {
      recon: session.rootRecon,
      provider,
      trigger: 'git-pull-auto',
      skipLlmSynthesis: provider.provider === 'demo',
    });
    updateSessionKnowledge(session, refreshed.knowledgeMap, refreshed.status);

    const completed: ToolActivity = {
      id: actId,
      toolName: 'refresh_knowledge_map',
      summary: `Auto-refreshed Knowledge Map after git update (${oldShort} → ${newShort}, ${refreshed.changedFilesCount} file${refreshed.changedFilesCount === 1 ? '' : 's'} updated)`,
      target: newShort,
      status: 'completed',
    };
    callbacks.recordActivity(completed);
    callbacks.emit({ type: 'tool-activity', activity: completed });
    callbacks.emit({
      type: 'session-state',
      currentStage: session.currentStage,
      completedStages: [...session.completedStages].sort((a, b) => a - b),
      diagnostic: { ...session.diagnostic },
      learning: cloneLearningState(session.learning),
      knowledgeStatus: session.knowledgeStatus ? { ...session.knowledgeStatus } : undefined,
      observedFilesCount: session.observedFiles.size,
      observedCommitsCount: session.observedCommits.size,
    });
  } catch {
    // Non-fatal: continue onboarding turn with existing knowledge map
  }
}
