import crypto from 'node:crypto';
import type { OnboardingStage, SSEEvent, ToolActivity, UserLevel, VisualArtifact } from '../../shared/types.js';
import type { InternalSession } from '../session/sessionStore.js';
import {
  detectJumpAheadRequest,
  inferUserLevelFromText,
  mergeDiagnosticProfile,
} from '../session/stageMachine.js';
import { listTree, readFileSlice } from '../tools/fsTools.js';
import { gitInspect } from '../tools/gitTools.js';
import { generateConceptVisual } from '../tools/visualTools.js';

interface DemoRunCallbacks {
  emit: (event: SSEEvent) => void;
  recordVisual: (visual: VisualArtifact) => void;
  recordActivity: (activity: ToolActivity) => void;
  recalibrated: UserLevel | null;
}

/**
 * Grounded local Demo Agent that runs real read-only fs/git tools against the target repo
 * and walks progressively through Stages 0–4 with adaptive depth and inline Mermaid visuals,
 * allowing full end-to-end verification without external LLM API keys.
 */
export async function runDemoTurn(
  session: InternalSession,
  userMessage: string,
  callbacks: DemoRunCallbacks
): Promise<string> {
  const lower = userMessage.toLowerCase();
  const recalibrated = callbacks.recalibrated;

  // 1. Determine target stage
  const jump = detectJumpAheadRequest(userMessage);
  let targetStage: OnboardingStage = session.currentStage;

  if (session.currentStage === 0) {
    const inferred = recalibrated ?? inferUserLevelFromText(userMessage, 'intermediate');
    session.diagnostic = mergeDiagnosticProfile(session.diagnostic, {
      inferredLevel: inferred,
      goal: userMessage.slice(0, 120),
      completed: true,
    });
    session.completedStages.add(0);
    targetStage = jump.requested && jump.targetStage ? jump.targetStage : 1;
  } else if (jump.requested && jump.targetStage !== undefined) {
    for (let s = 0; s < jump.targetStage; s++) {
      session.completedStages.add(s as OnboardingStage);
    }
    targetStage = jump.targetStage;
  } else if (
    /\b(next|continue|proceed|move on|ready|stage\s*[1-4]|architecture|flows?|history|evolution|git)\b/.test(lower) &&
    !recalibrated
  ) {
    if (/\b(stage\s*1|purpose|domain)\b/.test(lower)) targetStage = 1;
    else if (/\b(stage\s*2|architecture|module)\b/.test(lower)) targetStage = 2;
    else if (/\b(stage\s*3|flow|implementation|code|entry)\b/.test(lower)) targetStage = 3;
    else if (/\b(stage\s*4|history|evolution|git|next steps)\b/.test(lower)) targetStage = 4;
    else if (session.currentStage < 4) targetStage = (session.currentStage + 1) as OnboardingStage;
  }

  for (let s = 0; s < targetStage; s++) {
    session.completedStages.add(s as OnboardingStage);
  }
  session.currentStage = targetStage;
  session.updatedAt = new Date().toISOString();

  callbacks.emit({
    type: 'session-state',
    currentStage: session.currentStage,
    completedStages: [...session.completedStages].sort((a, b) => a - b),
    diagnostic: { ...session.diagnostic },
    observedFilesCount: session.observedFiles.size,
    observedCommitsCount: session.observedCommits.size,
  });

  const level: UserLevel =
    session.diagnostic.inferredLevel === 'uncalibrated'
      ? 'intermediate'
      : session.diagnostic.inferredLevel;

  let responseText = '';

  if (targetStage === 1) {
    responseText = await buildStage1Response(session, level, callbacks);
  } else if (targetStage === 2) {
    responseText = await buildStage2Response(session, level, callbacks);
  } else if (targetStage === 3) {
    responseText = await buildStage3Response(session, level, callbacks);
  } else {
    responseText = await buildStage4Response(session, level, callbacks);
  }

  if (recalibrated) {
    responseText = `> *Calibrated explanation depth to **${recalibrated}**.*\n\n${responseText}`;
  }

  // Stream smoothly in natural chunks
  const chunks = responseText.match(/.{1,48}(\s|$)|\n+/g) ?? [responseText];
  for (const chunk of chunks) {
    callbacks.emit({ type: 'text-delta', delta: chunk });
    await sleep(10);
  }

  return responseText;
}

async function emitToolStep<T>(
  callbacks: DemoRunCallbacks,
  toolName: string,
  summary: string,
  target: string,
  fn: () => Promise<T>
): Promise<T> {
  const id = `act_${crypto.randomUUID().slice(0, 8)}`;
  callbacks.emit({ type: 'tool-activity', activity: { id, toolName, summary, target, status: 'running' } });
  const result = await fn();
  const done: ToolActivity = { id, toolName, summary, target, status: 'completed' };
  callbacks.recordActivity(done);
  callbacks.emit({ type: 'tool-activity', activity: done });
  return result;
}

async function buildStage1Response(
  session: InternalSession,
  level: UserLevel,
  callbacks: DemoRunCallbacks
): Promise<string> {
  const recon = session.rootRecon;
  const dirs = recon.topLevelEntries.filter((e) => e.type === 'dir').map((e) => e.name);
  const files = recon.topLevelEntries.filter((e) => e.type === 'file').map((e) => e.name);

  const conceptVisual = await emitToolStep(
    callbacks,
    'generate_concept_visual',
    `Created domain mental model for ${recon.repoName}`,
    recon.repoName,
    () =>
      generateConceptVisual({
        title: `${recon.repoName} — Domain Mental Model`,
        metaphor: `Grounded from ${recon.readmePath ?? 'root layout'} and ${recon.manifests.length} root manifest(s).`,
        caption: 'High-level domain boundaries inferred from repository root artifacts.',
        elements: [
          { label: recon.repoName, role: recon.detectedStack.slice(0, 2).join(' · ') || 'Primary codebase' },
          { label: dirs[0] ? `${dirs[0]}/` : 'Core Source', role: 'Primary domain modules' },
          { label: recon.manifests[0]?.path ?? 'Configuration', role: 'Runtime & build contracts' },
        ],
      })
  );
  callbacks.recordVisual(conceptVisual);
  callbacks.emit({ type: 'visual', visual: conceptVisual });

  const readmeFirstLines = recon.readmeExcerpt
    ? recon.readmeExcerpt
        .split('\n')
        .map((l) => l.replace(/^\s*\d+\s*\|\s*/, '').trim())
        .filter((l) => l.length > 0 && !l.startsWith('!['))
        .slice(0, 4)
        .join(' ')
    : 'No root README was found, so purpose is anchored in the root manifests and directory layout.';

  const levelNote =
    level === 'foundational'
      ? `Think of **\`${recon.repoName}\`** as a workspace organized around clear layers: root configuration files define how the project runs, while top-level folders separate responsibilities so changes stay isolated.`
      : level === 'advanced'
        ? `At the boundary level, **\`${recon.repoName}\`** declares its build/runtime contracts via ${recon.manifests.map((m) => `\`${m.path}\``).join(', ') || 'root configs'} and partitions domain responsibilities across ${dirs.slice(0, 5).map((d) => `\`${d}/\``).join(', ') || 'top-level source files'}.`
        : `**\`${recon.repoName}\`** structures its runtime configuration at the repository root (${recon.manifests.map((m) => `\`${m.path}\``).slice(0, 4).join(', ') || 'root files'}) and organizes implementation concerns into ${dirs.slice(0, 5).map((d) => `\`${d}/\``).join(', ') || 'top-level files'}.`;

  return [
    `### Stage 1 — Repo Purpose & Domain`,
    '',
    `Thanks—I've calibrated our session to **${level}** depth *(Demo Mode — grounded directly in your local repo)*.`,
    '',
    `#### What \`${recon.repoName}\` Does`,
    readmeFirstLines,
    '',
    `#### Domain Boundaries`,
    levelNote,
    '',
    `- **Stack signals:** ${recon.detectedStack.join(', ') || 'Not explicitly declared in root manifests'}`,
    `- **Top-level directories:** ${dirs.length > 0 ? dirs.map((d) => `\`${d}/\``).join(', ') : 'None (flat root layout)'}`,
    `- **Key root files:** ${files.slice(0, 8).map((f) => `\`${f}\``).join(', ') || 'None'}`,
    '',
    `Ready to move to **Stage 2 (System Architecture)** and map how the modules fit together visually? *(Or say "go simpler" / "go deeper" anytime.)*`,
  ].join('\n');
}

async function buildStage2Response(
  session: InternalSession,
  level: UserLevel,
  callbacks: DemoRunCallbacks
): Promise<string> {
  const tree = await emitToolStep(
    callbacks,
    'list_tree',
    'Mapped module hierarchy (depth 3)',
    '.',
    () => listTree(session.repoPath, { path: '.', maxDepth: 3, maxEntries: 120 })
  );
  for (const e of tree.entries) session.observedFiles.add(e.path);

  const topDirs = tree.entries.filter((e) => e.depth === 1 && e.type === 'dir').slice(0, 6);
  const secondLevelByParent = new Map<string, string[]>();
  for (const e of tree.entries.filter((x) => x.depth === 2)) {
    const parent = e.path.split('/')[0];
    const list = secondLevelByParent.get(parent) ?? [];
    if (list.length < 4) list.push(e.name + (e.type === 'dir' ? '/' : ''));
    secondLevelByParent.set(parent, list);
  }

  const diagramLines = ['flowchart TD', `  ROOT["${sanitizeMermaid(session.repoName)} (Repository Root)"]`];
  if (topDirs.length > 0) {
    topDirs.forEach((dir, idx) => {
      const nodeId = `M${idx}`;
      const children = secondLevelByParent.get(dir.name) ?? [];
      const suffix = children.length > 0 ? `\\n${children.slice(0, 3).join(', ')}` : '';
      diagramLines.push(`  ${nodeId}["${sanitizeMermaid(`${dir.name}/${suffix}`)}"]`);
      diagramLines.push(`  ROOT --> ${nodeId}`);
    });
  } else {
    const topFiles = tree.entries.filter((e) => e.depth === 1).slice(0, 5);
    topFiles.forEach((f, idx) => {
      diagramLines.push(`  F${idx}["${sanitizeMermaid(f.name)}"]`);
      diagramLines.push(`  ROOT --> F${idx}`);
    });
  }

  const diagram: VisualArtifact = {
    id: `vis_${crypto.randomUUID().slice(0, 8)}`,
    kind: 'mermaid',
    title: `${session.repoName} — Module Architecture`,
    caption: 'Grounded top-level module layout derived from read-only repository tree inspection.',
    source: diagramLines.join('\n'),
  };
  callbacks.recordVisual(diagram);
  callbacks.emit({ type: 'visual', visual: diagram });

  const moduleBullets =
    topDirs.length > 0
      ? topDirs
          .map((d) => {
            const kids = secondLevelByParent.get(d.name) ?? [];
            return `- **\`${d.path}/\`** — contains ${kids.length > 0 ? kids.map((k) => `\`${k}\``).join(', ') : 'module files'}`;
          })
          .join('\n')
      : `- Flat repository layout with ${tree.entries.length} inspected entries at the root.`;

  const styleCommentary =
    level === 'foundational'
      ? 'Each box in the diagram above is a real top-level folder in this repository. Keeping code grouped by responsibility makes it easier to find where a feature lives without scanning everything.'
      : level === 'advanced'
        ? 'Notice the module boundary separation at depth 1–2: configuration and toolchain contracts stay pinned at the root while runtime/domain subsystems isolate inside dedicated subdirectories, minimizing cross-cutting blast radius.'
        : 'The diagram above maps the actual top-level boundaries we just scanned. Root manifests orchestrate builds/tests while subdirectories isolate domain logic and supporting modules.';

  return [
    `### Stage 2 — System Architecture`,
    '',
    styleCommentary,
    '',
    `#### Major Modules & Boundaries`,
    moduleBullets,
    '',
    `Next, we can move to **Stage 3 (Core Flows & Implementation)** to inspect a concrete entry-point file and trace execution step by step.`,
  ].join('\n');
}

async function buildStage3Response(
  session: InternalSession,
  level: UserLevel,
  callbacks: DemoRunCallbacks
): Promise<string> {
  const tree = await emitToolStep(
    callbacks,
    'list_tree',
    'Located candidate entry-point files',
    '.',
    () => listTree(session.repoPath, { path: '.', maxDepth: 3, maxEntries: 120 })
  );

  const codeExtensions = /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php)$/i;
  const candidateFiles = tree.entries.filter((e) => e.type === 'file' && codeExtensions.test(e.name));
  const preferred =
    candidateFiles.find((f) => /(index|main|app|server|cli)\./i.test(f.name)) ??
    candidateFiles[0] ??
    tree.entries.find((e) => e.type === 'file');

  let snippetNote = 'No source file was available to read.';
  let inspectedPath = preferred?.path ?? 'README.md';

  if (preferred) {
    const fileData = await emitToolStep(
      callbacks,
      'read_file',
      `Inspected entry point ${preferred.path} (L1-45)`,
      preferred.path,
      () => readFileSlice(session.repoPath, { path: preferred.path, startLine: 1, endLine: 45 })
    );
    session.observedFiles.add(fileData.path);
    inspectedPath = fileData.path;

    const exportLines = fileData.content
      .split('\n')
      .filter((l) => /\b(export|function|class|def|func|async|const|import)\b/.test(l))
      .slice(0, level === 'foundational' ? 5 : 10);

    snippetNote =
      exportLines.length > 0
        ? `Key declarations observed in \`${fileData.path}\` (${fileData.totalLines} lines total):\n\`\`\`\n${exportLines.join('\n')}\n\`\`\``
        : `Inspected \`${fileData.path}\` (${fileData.totalLines} lines total).`;
  }

  const flowDiagram: VisualArtifact = {
    id: `vis_${crypto.randomUUID().slice(0, 8)}`,
    kind: 'mermaid',
    title: `Core Execution Flow — ${inspectedPath}`,
    caption: 'High-level runtime flow anchored to an actual inspected entry point.',
    source: [
      'sequenceDiagram',
      '  participant Caller as User / Runtime Trigger',
      `  participant Entry as ${sanitizeMermaid(inspectedPath)}`,
      '  participant Modules as Core Domain Modules',
      '  Caller->>Entry: Invokes entry point / request',
      '  Entry->>Modules: Delegates validated work',
      '  Modules-->>Entry: Returns structured result',
      '  Entry-->>Caller: Emits output / response',
    ].join('\n'),
  };
  callbacks.recordVisual(flowDiagram);
  callbacks.emit({ type: 'visual', visual: flowDiagram });

  const depthCommentary =
    level === 'foundational'
      ? `When someone runs or interacts with \`${session.repoName}\`, execution enters through files like \`${inspectedPath}\` and hands off work to internal helper modules rather than putting all logic in one giant file.`
      : level === 'advanced'
        ? `Tracing from \`${inspectedPath}\`, check how imports establish dependency direction and where boundary validation occurs before delegating into core modules. Configure a live LLM provider in \`.env\` to trace multi-file symbol graphs interactively.`
        : `Starting at \`${inspectedPath}\`, we can trace how incoming inputs are wired to core modules and returned to callers.`;

  return [
    `### Stage 3 — Core Flows & Implementation`,
    '',
    depthCommentary,
    '',
    snippetNote,
    '',
    `Ready for **Stage 4 (Git Evolution, Conventions & Next Steps)** to examine recent commits, local conventions, and recommended files to explore next?`,
  ].join('\n');
}

async function buildStage4Response(
  session: InternalSession,
  level: UserLevel,
  callbacks: DemoRunCallbacks
): Promise<string> {
  const recon = session.rootRecon;
  let gitSection = 'This directory is not a Git repository, so historical commit analysis is unavailable.';

  if (recon.isGitRepo) {
    const logRes = await emitToolStep(
      callbacks,
      'git_inspect',
      'Inspected recent commit history (git log --stat)',
      'git log',
      () => gitInspect(session.repoPath, { subcommand: 'log', args: ['-n', '6', '--stat', '--oneline'] })
    );
    for (const sha of logRes.observedCommits) session.observedCommits.add(sha);

    const milestoneBullets =
      recon.recentMilestones.length > 0
        ? recon.recentMilestones
            .slice(0, 6)
            .map((m) => `- \`${m.shortHash}\` (${m.date}, ${m.author}): ${m.subject}`)
            .join('\n')
        : 'No commits recorded yet.';

    gitSection = [
      `#### Recent Git Milestones`,
      milestoneBullets,
      recon.topContributors.length > 0
        ? `\n**Active contributors:** ${recon.topContributors.slice(0, 4).join(' · ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const nextFiles = [...session.observedFiles]
    .filter((p) => p.includes('/') || /\.(json|md|toml|yaml|yml|ts|js|py|go|rs)$/i.test(p))
    .slice(0, 5);

  const closingTip =
    level === 'advanced'
      ? 'For deeper architectural trade-off Q&A across arbitrary call chains, configure `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or an Ollama endpoint in `.env`.'
      : 'You can ask follow-up questions about any folder or file above, or connect Gemini/OpenAI/Anthropic/Ollama in `.env` for free-form Q&A.';

  return [
    `### Stage 4 — Git Evolution, Conventions & Next Steps`,
    '',
    gitSection,
    '',
    `#### Concrete Files to Inspect Next`,
    nextFiles.length > 0
      ? nextFiles.map((f) => `- \`${f}\``).join('\n')
      : `- Start with \`${recon.readmePath ?? recon.manifests[0]?.path ?? '.'}\``,
    '',
    closingTip,
  ].join('\n');
}

function sanitizeMermaid(text: string): string {
  return text.replace(/"/g, "'").replace(/[<>]/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
