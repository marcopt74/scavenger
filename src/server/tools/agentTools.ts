import crypto from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import type { OnboardingStage, SSEEvent, ToolActivity, UserLevel, VisualArtifact } from '../../shared/types.js';
import { GuardrailViolationError } from '../guardrails/pathGuard.js';
import type { InternalSession } from '../session/sessionStore.js';
import { mergeDiagnosticProfile, validateStageTransition } from '../session/stageMachine.js';
import { grepSearch, listTree, readFileSlice } from './fsTools.js';
import { gitInspect } from './gitTools.js';
import { generateConceptVisual, renderD2ToSvg } from './visualTools.js';

export interface ToolContextCallbacks {
  emit: (event: SSEEvent) => void;
  recordVisual: (visual: VisualArtifact) => void;
  recordActivity: (activity: ToolActivity) => void;
  userRequestedJump: boolean;
}

export function createAgentTools(session: InternalSession, ctx: ToolContextCallbacks) {
  function emitSessionState(): void {
    ctx.emit({
      type: 'session-state',
      currentStage: session.currentStage,
      completedStages: [...session.completedStages].sort((a, b) => a - b),
      diagnostic: { ...session.diagnostic },
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

    update_onboarding_state: tool({
      description:
        'Update the onboarding session stage (0..4) and/or adaptive user level calibration based on diagnostic answers or user requests. Always call this when advancing stages or calibrating explanation level.',
      inputSchema: z.object({
        targetStage: z.number().int().min(0).max(4).optional().describe('Target onboarding stage (0-4).'),
        inferredLevel: z
          .enum(['foundational', 'intermediate', 'advanced'])
          .optional()
          .describe('Calibrated technical depth level for the user.'),
        stackFamiliarity: z.string().optional().describe('Short summary of user stack familiarity.'),
        goal: z.string().optional().describe('Short summary of user goal for exploring this repo.'),
        preferredDepth: z.string().optional().describe('Short summary of user preferred explanation depth.'),
      }),
      execute: async ({ targetStage, inferredLevel, stackFamiliarity, goal, preferredDepth }) =>
        runTracked(
          'update_onboarding_state',
          `Updated onboarding state${targetStage !== undefined ? ` -> Stage ${targetStage}` : ''}${inferredLevel ? ` (${inferredLevel})` : ''}`,
          undefined,
          async () => {
            const notes: string[] = [];

            if (inferredLevel || stackFamiliarity || goal || preferredDepth) {
              session.diagnostic = mergeDiagnosticProfile(session.diagnostic, {
                inferredLevel: inferredLevel as UserLevel | undefined,
                stackFamiliarity,
                goal,
                preferredDepth,
                completed: true,
              });
              notes.push(`Calibration updated (${session.diagnostic.inferredLevel}).`);
            }

            if (targetStage !== undefined) {
              const target = targetStage as OnboardingStage;
              const check = validateStageTransition(session.currentStage, target, {
                userRequestedJump: ctx.userRequestedJump,
              });
              if (check.allowed) {
                for (let s = 0; s < check.nextStage; s++) {
                  session.completedStages.add(s as OnboardingStage);
                }
                session.currentStage = check.nextStage;
                notes.push(`Moved to Stage ${session.currentStage}.`);
              } else {
                session.completedStages.add(session.currentStage);
                session.currentStage = check.nextStage;
                notes.push(check.reason || `Advanced progressively to Stage ${check.nextStage}.`);
              }
            }

            session.updatedAt = new Date().toISOString();
            return {
              currentStage: session.currentStage,
              completedStages: [...session.completedStages].sort((a, b) => a - b),
              diagnostic: session.diagnostic,
              note: notes.join(' '),
            };
          }
        ),
    }),

    render_diagram: tool({
      description:
        'Render an inline visual diagram (SVG) directly in the chat UI. Prefer format="mermaid" unless D2 is explicitly available and beneficial. Use clear, concise node labels without raw syntax clutter in prose.',
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
        'Generate an optional visual metaphor or mental-model illustration card when a conceptual analogy clarifies the system better than text alone (automatically falls back to a clean vector concept card if raster image generation is unavailable).',
      inputSchema: z.object({
        title: z.string().describe('Title of the mental model or architectural metaphor.'),
        metaphor: z.string().describe('Concise 1-2 sentence explanation of the metaphor.'),
        caption: z.string().optional().describe('Caption shown underneath the visual.'),
        elements: z
          .array(
            z.object({
              label: z.string().describe('Component or concept name (2-4 words).'),
              role: z.string().describe('Short role description (3-7 words).'),
            })
          )
          .min(2)
          .max(4)
          .optional()
          .describe('Key mapped conceptual elements for the visual.'),
      }),
      execute: async ({ title, metaphor, caption, elements }) =>
        runTracked('generate_concept_visual', `Generated concept visual: ${title}`, title, async () => {
          const artifact = await generateConceptVisual({ title, metaphor, caption, elements });
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
