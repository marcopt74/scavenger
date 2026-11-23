import crypto from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { PILLAR_TO_STAGE } from '../../shared/types.js';
import type {
  CheckInQuestion,
  CorePillarId,
  OnboardingStage,
  SSEEvent,
  SuggestedNextStep,
  ToolActivity,
  TopicMastery,
  UserLevel,
  VisualArtifact,
} from '../../shared/types.js';
import { GuardrailViolationError } from '../guardrails/pathGuard.js';
import { queryKnowledgeMap, scanOrRefreshRepoKnowledge } from '../knowledge/scannerAgent.js';
import {
  cloneLearningState,
  setCheckInQuestions,
  setSuggestedNextSteps,
  upsertTopicMastery,
} from '../session/learningEngine.js';
import { updateSessionKnowledge } from '../session/sessionStore.js';
import type { InternalSession } from '../session/sessionStore.js';
import { mergeDiagnosticProfile } from '../session/stageMachine.js';
import { grepSearch, listTree, readFileSlice } from './fsTools.js';
import { gitInspect } from './gitTools.js';
import { generateConceptVisual, renderD2ToSvg } from './visualTools.js';

export interface ToolContextCallbacks {
  emit: (event: SSEEvent) => void;
  recordVisual: (visual: VisualArtifact) => void;
  recordActivity: (activity: ToolActivity) => void;
  recordLessonFooter: (footer: {
    checkInQuestions?: CheckInQuestion[];
    suggestedNextSteps?: SuggestedNextStep[];
  }) => void;
}

const masteryEnum = z.enum(['unexplored', 'introduced', 'developing', 'solid']);
const pillarEnum = z.enum(['recon', 'purpose', 'architecture', 'flows', 'evolution']);

export function createAgentTools(session: InternalSession, ctx: ToolContextCallbacks) {
  function emitSessionState(): void {
    ctx.emit({
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

  async function runTracked<T>(
    toolName: string,
    summary: string,
    target: string | undefined,
    fn: () => Promise<T>
  ): Promise<T | { error: string; blocked?: boolean }> {
    const id = `act_${crypto.randomUUID().slice(0, 8)}`;
    const running: ToolActivity = { id, toolName, summary, target, status: 'running' };
    ctx.emit({ type: 'tool-activity', activity: running });

    try {
      const result = await fn();
      const done: ToolActivity = { id, toolName, summary, target, status: 'completed' };
      ctx.recordActivity(done);
      ctx.emit({ type: 'tool-activity', activity: done });
      emitSessionState();
      return result;
    } catch (err) {
      const isBlocked = err instanceof GuardrailViolationError;
      const message = err instanceof Error ? err.message : String(err);
      const failed: ToolActivity = {
        id,
        toolName,
        summary,
        target,
        status: isBlocked ? 'blocked' : 'error',
        detail: message,
      };
      ctx.recordActivity(failed);
      ctx.emit({ type: 'tool-activity', activity: failed });
      return { error: message, blocked: isBlocked };
    }
  }

  return {
    query_knowledge_map: tool({
      description:
        'Instantly query the pre-scanned Repository Knowledge Map in memory (modules, exported symbols with exact line numbers, file imports/dependents, entry points, and core execution flows). Prefer calling this first before running exploratory list_tree or grep_search calls—only use read_file when you need to inspect line-by-line implementation details.',
      inputSchema: z.object({
        queryType: z
          .enum(['overview', 'module', 'symbol', 'file', 'dependents', 'flow'])
          .describe(
            'What to look up in the Knowledge Map: "overview" (high-level modules & flows), "module" (files & exports in a module), "symbol" (locate exported function/class/type/const with line numbers), "file" (file metadata, exports & imports), "dependents" (incoming/outgoing dependency edges), or "flow" (core execution flows).'
          ),
        target: z
          .string()
          .optional()
          .describe('Optional module id, symbol name, file path substring, or flow name to filter by.'),
      }),
      execute: async ({ queryType, target }) =>
        runTracked(
          'query_knowledge_map',
          `Queried Knowledge Map (${queryType}${target ? `: "${target}"` : ''})`,
          target || queryType,
          async () => {
            if (!session.knowledgeMap) {
              const scanned = await scanOrRefreshRepoKnowledge(session.repoPath, {
                recon: session.rootRecon,
                provider: session.provider,
                skipLlmSynthesis: true,
              });
              updateSessionKnowledge(session, scanned.knowledgeMap, scanned.status);
            }
            return queryKnowledgeMap(session.knowledgeMap!, { queryType, target });
          }
        ),
    }),

    list_tree: tool({
      description:
        'List files and directories inside the target repository (read-only, bounded depth). Always stay scoped inside the repo.',
      inputSchema: z.object({
        path: z.string().optional().describe('Repo-relative directory path, defaults to "." (repository root).'),
        maxDepth: z.number().int().min(1).max(6).optional().describe('Maximum traversal depth (1-6, default 3).'),
        maxEntries: z.number().int().min(10).max(400).optional().describe('Maximum entries returned (default 160).'),
      }),
      execute: async ({ path, maxDepth, maxEntries }) =>
        runTracked('list_tree', `Inspected tree at ${path || '.'}`, path || '.', async () => {
          const result = await listTree(session.repoPath, { path, maxDepth, maxEntries });
          for (const entry of result.entries) {
            session.observedFiles.add(entry.path);
          }
          return result;
        }),
    }),

    read_file: tool({
      description:
        'Read a bounded line range of a single file inside the target repository (strictly read-only). Prefer reading targeted line windows rather than dumping entire large files.',
      inputSchema: z.object({
        path: z.string().describe('Repo-relative file path to inspect.'),
        startLine: z.number().int().min(1).optional().describe('1-based starting line number (default 1).'),
        endLine: z.number().int().min(1).optional().describe('1-based inclusive ending line number (max 250 lines per call).'),
      }),
      execute: async ({ path, startLine, endLine }) =>
        runTracked(
          'read_file',
          `Read ${path}${startLine ? ` (L${startLine}${endLine ? `-${endLine}` : '+'})` : ''}`,
          path,
          async () => {
            const result = await readFileSlice(session.repoPath, { path, startLine, endLine });
            session.observedFiles.add(result.path);
            return result;
          }
        ),
    }),

    grep_search: tool({
      description:
        'Search for text or regex patterns across text files inside the target repository (read-only).',
      inputSchema: z.object({
        query: z.string().describe('Text substring or regular expression to search for.'),
        path: z.string().optional().describe('Optional repo-relative directory or file scope.'),
        isRegex: z.boolean().optional().describe('Treat query as a regular expression (default false).'),
        maxMatches: z.number().int().min(1).max(100).optional().describe('Maximum matches to return (default 40).'),
      }),
      execute: async ({ query, path, isRegex, maxMatches }) =>
        runTracked(
          'grep_search',
          `Searched "${query.slice(0, 32)}"${path ? ` in ${path}` : ''}`,
          path || '.',
          async () => {
            const result = await grepSearch(session.repoPath, { query, path, isRegex, maxMatches });
            for (const match of result.matches) {
              session.observedFiles.add(match.path);
            }
            return result;
          }
        ),
    }),

    git_inspect: tool({
      description:
        'Run strictly read-only git inspection commands (allowed subcommands: log, show, diff, blame, shortlog, status, rev-parse, branch --list, tag --list, ls-files). All mutating git commands are blocked.',
      inputSchema: z.object({
        subcommand: z
          .enum(['log', 'show', 'diff', 'blame', 'shortlog', 'status', 'rev-parse', 'branch', 'tag', 'ls-files'])
          .describe('Read-only git subcommand.'),
        args: z
          .array(z.string())
          .optional()
          .describe('Read-only git flags/arguments (e.g. ["-n", "10", "--oneline"]).'),
      }),
      execute: async ({ subcommand, args }) =>
        runTracked(
          'git_inspect',
          `Ran git ${subcommand}${args?.length ? ` ${args.slice(0, 3).join(' ')}` : ''}`,
          `git ${subcommand}`,
          async () => {
            const result = await gitInspect(session.repoPath, { subcommand, args });
            for (const sha of result.observedCommits) {
              session.observedCommits.add(sha);
            }
            return result;
          }
        ),
    }),

    update_learning_state: tool({
      description:
        'Update the adaptive knowledge map, topic mastery, explanation depth, optional post-lesson check-in questions (0-3), and suggested next learning steps (2-3). Call this on every substantive teaching turn to keep the UI Knowledge Map, Quick Check card, and Next Steps cards synchronized.',
      inputSchema: z.object({
        activeTopic: z
          .object({
            id: z.string().optional().describe('Existing topic id (e.g. "pillar:architecture" or "custom:auth-flow").'),
            title: z.string().describe('Human-readable topic title being taught or explored right now.'),
            kind: z.enum(['pillar', 'custom']).optional().describe('"pillar" for core repo pillars, "custom" for user-requested topics.'),
            pillarId: pillarEnum.optional().describe('If this lesson maps to a core pillar: recon, purpose, architecture, flows, or evolution.'),
            mastery: masteryEnum.describe('Current inferred user mastery for this topic.'),
            notes: z.string().optional().describe('Short note summarizing user understanding or gaps.'),
            relatedFiles: z.array(z.string()).optional().describe('Grounded repo-relative file paths inspected for this topic.'),
          })
          .optional(),
        previousTopicAssessment: z
          .object({
            id: z.string().optional().describe('Topic id of the previously studied topic being assessed.'),
            title: z.string().describe('Title of the previously studied topic.'),
            pillarId: pillarEnum.optional(),
            mastery: z.enum(['introduced', 'developing', 'solid']).describe('Updated mastery based on the user reply.'),
            notes: z.string().optional().describe('Brief evidence from user answer.'),
          })
          .optional()
          .describe('Update mastery of the prior topic after evaluating the user response to check-in questions.'),
        inferredLevel: z
          .enum(['foundational', 'intermediate', 'advanced'])
          .optional()
          .describe('Calibrated technical depth level for explanations.'),
        assessmentSummary: z
          .string()
          .optional()
          .describe('1-sentence summary of how the user understanding evolved this turn.'),
        diagnostic: z
          .object({
            stackFamiliarity: z.string().optional(),
            goal: z.string().optional(),
            preferredDepth: z.string().optional(),
          })
          .optional(),
        checkInQuestions: z
          .array(
            z.object({
              question: z.string().describe('Concise, thought-provoking comprehension question.'),
              focus: z.string().optional().describe('Concept or boundary being checked (2-4 words).'),
            })
          )
          .max(3)
          .optional()
          .describe('Up to 3 optional check-in questions to infer knowledge evolution after this lesson. Rendered cleanly inline by the UI—do not duplicate in prose.'),
        suggestedNextSteps: z
          .array(
            z.object({
              title: z.string().describe('Short clickable step title (3-7 words).'),
              rationale: z.string().describe('1 concise sentence explaining why this logically follows.'),
              prompt: z.string().describe('Message sent when the user clicks this card.'),
              kind: z.enum(['deepen', 'broaden', 'revisit', 'explore']).optional(),
              targetTopicId: z.string().optional(),
            })
          )
          .min(2)
          .max(3)
          .optional()
          .describe('2-3 concrete, repo-grounded next logical learning steps rendered as clickable cards below the lesson.'),
      }),
      execute: async (input) =>
        runTracked(
          'update_learning_state',
          `Updated knowledge map${input.activeTopic ? ` · ${input.activeTopic.title}` : ''}${input.inferredLevel ? ` (${input.inferredLevel})` : ''}`,
          input.activeTopic?.title,
          async () => {
            if (input.inferredLevel || input.diagnostic) {
              session.diagnostic = mergeDiagnosticProfile(session.diagnostic, {
                inferredLevel: input.inferredLevel as UserLevel | undefined,
                stackFamiliarity: input.diagnostic?.stackFamiliarity,
                goal: input.diagnostic?.goal,
                preferredDepth: input.diagnostic?.preferredDepth,
                completed: true,
              });
            }

            if (input.previousTopicAssessment) {
              const prev = upsertTopicMastery(session.learning, {
                id: input.previousTopicAssessment.id,
                title: input.previousTopicAssessment.title,
                pillarId: input.previousTopicAssessment.pillarId as CorePillarId | undefined,
                mastery: input.previousTopicAssessment.mastery as TopicMastery,
                notes: input.previousTopicAssessment.notes,
                setActive: false,
              });
              syncPillarCompletion(session, prev.pillarId, prev.mastery);
            }

            if (input.activeTopic) {
              const active = upsertTopicMastery(session.learning, {
                id: input.activeTopic.id,
                title: input.activeTopic.title,
                kind: input.activeTopic.kind,
                pillarId: input.activeTopic.pillarId as CorePillarId | undefined,
                mastery: input.activeTopic.mastery as TopicMastery,
                notes: input.activeTopic.notes,
                relatedFiles: input.activeTopic.relatedFiles,
                setActive: true,
              });
              if (active.pillarId) {
                session.currentStage = PILLAR_TO_STAGE[active.pillarId];
                syncPillarCompletion(session, active.pillarId, active.mastery);
              }
            }

            if (input.assessmentSummary?.trim()) {
              session.learning.lastAssessmentSummary = input.assessmentSummary.trim();
            }

            let savedQuestions: CheckInQuestion[] | undefined;
            if (input.checkInQuestions !== undefined) {
              savedQuestions = setCheckInQuestions(session.learning, input.checkInQuestions);
            }

            let savedSteps: SuggestedNextStep[] | undefined;
            if (input.suggestedNextSteps !== undefined) {
              savedSteps = setSuggestedNextSteps(session.learning, input.suggestedNextSteps);
            }

            ctx.recordLessonFooter({
              checkInQuestions: savedQuestions,
              suggestedNextSteps: savedSteps,
            });

            session.updatedAt = new Date().toISOString();
            return {
              activeTopicId: session.learning.activeTopicId,
              activeTopicTitle: session.learning.activeTopicTitle,
              inferredLevel: session.diagnostic.inferredLevel,
              checkInCount: savedQuestions?.length ?? session.learning.pendingCheckIn.length,
              suggestedStepsCount: savedSteps?.length ?? session.learning.suggestedNextSteps.length,
              note: 'Knowledge map, Quick Check questions, and Suggested Next Steps updated in the UI. Do not repeat the Quick Check list or Next Step cards verbatim in prose.',
            };
          }
        ),
    }),

    render_diagram: tool({
      description:
        'Render an inline visual diagram (SVG) directly in the chat UI. Prefer format="mermaid" unless D2 is explicitly available and beneficial. Make diagrams clean and scannable: use concise quoted labels, descriptive edge labels, 2-3 named subgraphs for boundaries, and optional pre-styled semantic classes (:::entry, :::core, :::guard, :::data, :::external) on flowchart nodes, or autonumber + activate/Note in sequenceDiagrams. Do not repeat raw syntax in prose.',
      inputSchema: z.object({
        format: z.enum(['mermaid', 'd2']).default('mermaid').describe('Diagram language ("mermaid" recommended).'),
        title: z.string().describe('Short human-readable diagram title.'),
        caption: z.string().optional().describe('1-sentence caption explaining what the diagram highlights.'),
        source: z.string().describe('Valid Mermaid or D2 diagram source code.'),
      }),
      execute: async ({ format, title, caption, source }) =>
        runTracked('render_diagram', `Rendered ${format.toUpperCase()} diagram: ${title}`, title, async () => {
          const id = `vis_${crypto.randomUUID().slice(0, 8)}`;

          if (format === 'd2') {
            const compiled = await renderD2ToSvg(source);
            const artifact: VisualArtifact = {
              id,
              kind: 'd2',
              title,
              caption,
              source,
              svgMarkup: compiled.ok ? compiled.svg : undefined,
              renderError: compiled.ok ? undefined : compiled.error,
            };
            ctx.recordVisual(artifact);
            ctx.emit({ type: 'visual', visual: artifact });
            return {
              rendered: compiled.ok,
              id,
              format: 'd2',
              note: compiled.ok
                ? 'D2 diagram compiled to SVG and displayed inline.'
                : `D2 unavailable (${compiled.error}); fallback card shown. Prefer Mermaid for subsequent diagrams.`,
            };
          }

          const artifact: VisualArtifact = {
            id,
            kind: 'mermaid',
            title,
            caption,
            source: source.trim(),
          };
          ctx.recordVisual(artifact);
          ctx.emit({ type: 'visual', visual: artifact });
          return {
            rendered: true,
            id,
            format: 'mermaid',
            note: 'Mermaid diagram attached and rendered inline as SVG in the UI. Do not repeat raw Mermaid syntax in your text response.',
          };
        }),
    }),

    generate_concept_visual: tool({
      description:
        'Generate an optional visual metaphor or mental-model illustration card when a conceptual analogy clarifies the system better than text alone (automatically falls back to an editorial multi-layout vector concept card if raster image generation is unavailable).',
      inputSchema: z.object({
        title: z.string().describe('Title of the mental model or architectural metaphor.'),
        metaphor: z.string().describe('Concise 1-2 sentence explanation of the metaphor.'),
        caption: z.string().optional().describe('Caption shown underneath the visual.'),
        layout: z
          .enum(['pipeline', 'hub', 'layers'])
          .optional()
          .describe('Visual composition: "pipeline" (sequential flow), "hub" (central core + collaborators), or "layers" (stacked architectural strata).'),
        accent: z
          .enum(['cobalt', 'emerald', 'violet', 'amber'])
          .optional()
          .describe('Visual accent palette: cobalt (general/core), emerald (guardrails/validation), violet (architecture/orchestration), amber (git/evolution).'),
        elements: z
          .array(
            z.object({
              label: z.string().describe('Component or concept name (2-4 words).'),
              role: z.string().describe('Short role description (3-8 words).'),
            })
          )
          .min(2)
          .max(4)
          .optional()
          .describe('Key mapped conceptual elements for the visual.'),
      }),
      execute: async ({ title, metaphor, caption, layout, accent, elements }) =>
        runTracked('generate_concept_visual', `Generated concept visual: ${title}`, title, async () => {
          const artifact = await generateConceptVisual({ title, metaphor, caption, layout, accent, elements });
          ctx.recordVisual(artifact);
          ctx.emit({ type: 'visual', visual: artifact });
          return {
            rendered: true,
            id: artifact.id,
            isFallback: artifact.kind === 'concept-image' ? artifact.isFallback : false,
            note: 'Concept visual displayed inline in the chat UI.',
          };
        }),
    }),
  };
}

function syncPillarCompletion(
  session: InternalSession,
  pillarId: CorePillarId | undefined,
  mastery: TopicMastery
): void {
  if (!pillarId) return;
  const stage: OnboardingStage = PILLAR_TO_STAGE[pillarId];
  if (mastery === 'developing' || mastery === 'solid') {
    session.completedStages.add(stage);
  }
}
