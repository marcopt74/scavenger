import crypto from 'node:crypto';
import { stepCountIs, streamText } from 'ai';
import type { ChatMessage, ProviderSelection, SSEEvent, ToolActivity, VisualArtifact } from '../../shared/types.js';
import { resolveLanguageModel } from '../config.js';
import type { InternalSession } from '../session/sessionStore.js';
import { detectJumpAheadRequest, detectRecalibrationSignal } from '../session/stageMachine.js';
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
      observedFilesCount: session.observedFiles.size,
      observedCommitsCount: session.observedCommits.size,
    });
  }

  const activeProvider = providerOverride ?? session.provider;
  const visuals: VisualArtifact[] = [];
  const toolActivities: ToolActivity[] = [];

  const recordVisual = (v: VisualArtifact) => visuals.push(v);
  const recordActivity = (a: ToolActivity) => {
    const idx = toolActivities.findIndex((existing) => existing.id === a.id);
    if (idx >= 0) toolActivities[idx] = a;
    else toolActivities.push(a);
  };

  let fullText = '';

  try {
    const model = resolveLanguageModel(activeProvider);

    if (!model) {
      // Grounded local demo mode
      fullText = await runDemoTurn(session, userText, {
        emit,
        recordVisual,
        recordActivity,
        recalibrated,
      });
    } else {
      const d2Available = await checkD2Available();
      const jump = detectJumpAheadRequest(userText);
      const tools = createAgentTools(session, {
        emit,
        recordVisual,
        recordActivity,
        userRequestedJump: jump.requested,
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
        stopWhen: stepCountIs(10),
        temperature: 0.3,
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
    visuals: visuals.length > 0 ? visuals : undefined,
    toolActivities: toolActivities.length > 0 ? toolActivities : undefined,
  };

  session.messages.push(assistantMessage);
  session.updatedAt = new Date().toISOString();

  emit({
    type: 'session-state',
    currentStage: session.currentStage,
    completedStages: [...session.completedStages].sort((a, b) => a - b),
    diagnostic: { ...session.diagnostic },
    observedFilesCount: session.observedFiles.size,
    observedCommitsCount: session.observedCommits.size,
  });
  emit({ type: 'done', message: assistantMessage });

  return assistantMessage;
}
