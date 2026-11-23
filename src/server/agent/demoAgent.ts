import crypto from 'node:crypto';
import { ONBOARDING_STAGES, PILLAR_TO_STAGE } from '../../shared/types.js';
import type {
  CheckInQuestion,
  CorePillarId,
  SSEEvent,
  SuggestedNextStep,
  ToolActivity,
  UserLevel,
  VisualArtifact,
} from '../../shared/types.js';
import {
  assessCheckInResponse,
  cloneLearningState,
  detectCustomTopicRequest,
  detectPillarRequest,
  makeCustomTopicId,
  makePillarTopicId,
  setCheckInQuestions,
  setSuggestedNextSteps,
  upsertTopicMastery,
} from '../session/learningEngine.js';
import type { InternalSession } from '../session/sessionStore.js';
import { inferUserLevelFromText, mergeDiagnosticProfile } from '../session/stageMachine.js';
import { grepSearch, listTree, readFileSlice } from '../tools/fsTools.js';
import { gitInspect } from '../tools/gitTools.js';
import { generateConceptVisual } from '../tools/visualTools.js';

interface DemoRunCallbacks {
  emit: (event: SSEEvent) => void;
  recordVisual: (visual: VisualArtifact) => void;
  recordActivity: (activity: ToolActivity) => void;
  recordLessonFooter: (footer: {
    checkInQuestions?: CheckInQuestion[];
    suggestedNextSteps?: SuggestedNextStep[];
  }) => void;
  recalibrated: UserLevel | null;
}

/**
 * Grounded local Demo Agent implementing the Whiteboard Mentor pedagogy:
 * - Teaches in flowing 5-beat lessons (mental model -> interdependencies -> over-time story -> subtle behavior -> takeaway)
 * - Supports custom user-requested topics with multi-file read-only inspection
 * - Evaluates pending check-in replies to evolve mastery and steer reinforcement vs. deepening
 * - Emits predictive Quick Check questions (<= 3) and 2-3 logical next learning steps
 */
export async function runDemoTurn(
  session: InternalSession,
  userMessage: string,
  callbacks: DemoRunCallbacks
): Promise<string> {
  const recalibrated = callbacks.recalibrated;

  if (!session.diagnostic.completed || !session.completedStages.has(0)) {
    const inferred = recalibrated ?? inferUserLevelFromText(userMessage, 'intermediate');
    session.diagnostic = mergeDiagnosticProfile(session.diagnostic, {
      inferredLevel: inferred,
      goal: userMessage.slice(0, 120),
      completed: true,
    });
    upsertTopicMastery(session.learning, {
      id: makePillarTopicId('recon'),
      title: ONBOARDING_STAGES[0].title,
      pillarId: 'recon',
      mastery: 'solid',
      notes: `Calibrated to ${inferred} depth.`,
      setActive: false,
    });
    session.completedStages.add(0);
  }

  const level: UserLevel =
    session.diagnostic.inferredLevel === 'uncalibrated'
      ? 'intermediate'
      : session.diagnostic.inferredLevel;

  const explicitPillar = detectPillarRequest(userMessage);
  const customTopic = explicitPillar ? null : detectCustomTopicRequest(userMessage);

  let assessmentPreface = '';
  let shouldReinforceActive = false;

  if (!explicitPillar && !customTopic && !recalibrated && session.learning.pendingCheckIn.length > 0) {
    const currentTopic = session.learning.topics.find((t) => t.id === session.learning.activeTopicId);
    if (currentTopic) {
      const assessment = assessCheckInResponse(userMessage, currentTopic.mastery, level);
      if (assessment.looksLikeCheckInReply) {
        upsertTopicMastery(session.learning, {
          id: currentTopic.id,
          title: currentTopic.title,
          pillarId: currentTopic.pillarId,
          mastery: assessment.newMastery,
          notes: assessment.summary,
          setActive: false,
        });
        session.learning.lastAssessmentSummary = assessment.summary;

        if (assessment.recommendedLevelShift === 'down' && session.diagnostic.inferredLevel === 'advanced') {
          session.diagnostic.inferredLevel = 'intermediate';
        } else if (
          assessment.recommendedLevelShift === 'up' &&
          session.diagnostic.inferredLevel === 'foundational'
        ) {
          session.diagnostic.inferredLevel = 'intermediate';
        }

        if (assessment.needsReinforcement) {
          shouldReinforceActive = true;
          assessmentPreface = `> **Mentor note:** Good instinct pausing on **${currentTopic.title}**—that boundary takes a moment to click. Let's step back to the whiteboard and re-anchor the mental model before adding more moving parts.\n\n`;
        } else {
          if (currentTopic.pillarId) {
            session.completedStages.add(PILLAR_TO_STAGE[currentTopic.pillarId]);
          }
          assessmentPreface = `> **Mentor note:** Solid reasoning on **${currentTopic.title}**—you captured how the responsibilities separate (mastery updated to **${assessment.newMastery}**). Let's build directly on that.\n\n`;
        }
      }
    }
  }

  const activeLevel: UserLevel =
    session.diagnostic.inferredLevel === 'uncalibrated'
      ? 'intermediate'
      : session.diagnostic.inferredLevel;

  let responseText = '';
  let checkIns: Array<{ question: string; focus: string }> = [];
  let nextSteps: Array<{
    title: string;
    rationale: string;
    prompt: string;
    kind: SuggestedNextStep['kind'];
    targetTopicId?: string;
  }> = [];

  if (customTopic) {
    const res = await buildCustomTopicLesson(session, customTopic, activeLevel, callbacks);
    responseText = res.text;
    checkIns = res.checkIns;
    nextSteps = res.nextSteps;
  } else if (shouldReinforceActive) {
    const active = session.learning.topics.find((t) => t.id === session.learning.activeTopicId);
    const res = await buildReinforcementLesson(
      session,
      active?.title ?? 'Current Topic',
      active?.relatedFiles ?? [],
      callbacks
    );
    responseText = res.text;
    checkIns = res.checkIns;
    nextSteps = res.nextSteps;
  } else {
    const chosenPillar = explicitPillar ?? pickNextLogicalPillar(session, recalibrated !== null);
    const res = await buildPillarLesson(session, chosenPillar, activeLevel, callbacks);
    responseText = res.text;
    checkIns = res.checkIns;
    nextSteps = res.nextSteps;
  }

  const savedCheckIns = setCheckInQuestions(session.learning, checkIns);
  const savedSteps = setSuggestedNextSteps(session.learning, nextSteps);
  callbacks.recordLessonFooter({
    checkInQuestions: savedCheckIns,
    suggestedNextSteps: savedSteps,
  });

  session.updatedAt = new Date().toISOString();
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

  if (recalibrated) {
    responseText = `> *Calibrated lesson depth to **${recalibrated}**.*\n\n${responseText}`;
  } else if (assessmentPreface) {
    responseText = `${assessmentPreface}${responseText}`;
  }

  const chunks = responseText.match(/.{1,54}(\s|$)|\n+/g) ?? [responseText];
  for (const chunk of chunks) {
    callbacks.emit({ type: 'text-delta', delta: chunk });
    await sleep(7);
  }

  return responseText;
}

function pickNextLogicalPillar(session: InternalSession, stayOnCurrent: boolean): CorePillarId {
  const active = session.learning.topics.find((t) => t.id === session.learning.activeTopicId);
  if (stayOnCurrent && active?.pillarId && active.pillarId !== 'recon') {
    return active.pillarId;
  }

  const order: CorePillarId[] = ['purpose', 'architecture', 'flows', 'evolution'];
  const unexplored = order.find((p) => {
    const topic = session.learning.topics.find((t) => t.pillarId === p);
    return !topic || topic.mastery === 'unexplored';
  });
  if (unexplored) return unexplored;

  const developing = order.find((p) => {
    const topic = session.learning.topics.find((t) => t.pillarId === p);
    return topic && topic.mastery !== 'solid';
  });
  return developing ?? 'architecture';
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

interface LessonOutput {
  text: string;
  checkIns: Array<{ question: string; focus: string }>;
  nextSteps: Array<{
    title: string;
    rationale: string;
    prompt: string;
    kind: SuggestedNextStep['kind'];
    targetTopicId?: string;
  }>;
}

async function buildCustomTopicLesson(
  session: InternalSession,
  rawTopic: string,
  level: UserLevel,
  callbacks: DemoRunCallbacks
): Promise<LessonOutput> {
  const cleanTitle = rawTopic.charAt(0).toUpperCase() + rawTopic.slice(1);
  const searchToken = rawTopic.split(/\s+/).find((w) => w.length >= 3) ?? rawTopic;

  const kmMatches: string[] = [];
  if (session.knowledgeMap) {
    const matchedFromKm = await emitToolStep(
      callbacks,
      'query_knowledge_map',
      `Queried Knowledge Map for "${searchToken}"`,
      searchToken,
      async () => {
        const lower = searchToken.toLowerCase();
        const files = session.knowledgeMap!.files
          .filter(
            (f) =>
              f.path.toLowerCase().includes(lower) ||
              f.exports.some((e) => e.name.toLowerCase().includes(lower))
          )
          .map((f) => f.path);
        return files.slice(0, 6);
      }
    );
    kmMatches.push(...matchedFromKm);
  }

  const tree = await emitToolStep(
    callbacks,
    'list_tree',
    `Scanning repository for "${rawTopic}"`,
    '.',
    () => listTree(session.repoPath, { path: '.', maxDepth: 4, maxEntries: 180 })
  );
  for (const e of tree.entries) session.observedFiles.add(e.path);

  const pathMatches = tree.entries
    .filter((e) => e.path.toLowerCase().includes(searchToken.toLowerCase()))
    .slice(0, 6);

  const grepRes = await emitToolStep(
    callbacks,
    'grep_search',
    `Searching codebase for "${searchToken}"`,
    '.',
    () => grepSearch(session.repoPath, { query: searchToken, maxMatches: 20 })
  );
  for (const m of grepRes.matches) session.observedFiles.add(m.path);

  const relatedFiles = [
    ...new Set([
      ...kmMatches,
      ...pathMatches.filter((p) => p.type === 'file').map((p) => p.path),
      ...grepRes.matches.map((m) => m.path),
    ]),
  ].slice(0, 6);

  const primaryFile = relatedFiles[0] ?? tree.entries.find((e) => e.type === 'file')?.path;
  const secondaryFile = relatedFiles[1];

  let primarySymbols: string[] = [];
  let primaryImports: string[] = [];
  let primaryTotalLines = 0;

  if (primaryFile) {
    const slice = await emitToolStep(
      callbacks,
      'read_file',
      `Read ${primaryFile} (L1-65)`,
      primaryFile,
      () => readFileSlice(session.repoPath, { path: primaryFile, startLine: 1, endLine: 65 })
    );
    session.observedFiles.add(slice.path);
    primaryTotalLines = slice.totalLines;
    primarySymbols = extractSymbolNames(slice.content);
    primaryImports = extractImportTargets(slice.content);
  }

  let secondarySymbols: string[] = [];
  if (secondaryFile) {
    const secondSlice = await emitToolStep(
      callbacks,
      'read_file',
      `Read collaborating file ${secondaryFile} (L1-45)`,
      secondaryFile,
      () => readFileSlice(session.repoPath, { path: secondaryFile, startLine: 1, endLine: 45 })
    );
    session.observedFiles.add(secondSlice.path);
    secondarySymbols = extractSymbolNames(secondSlice.content);
  }

  const topicId = makeCustomTopicId(cleanTitle);
  upsertTopicMastery(session.learning, {
    id: topicId,
    title: cleanTitle,
    kind: 'custom',
    mastery: 'introduced',
    notes: relatedFiles.length > 0 ? `Explored via ${relatedFiles.slice(0, 3).join(', ')}.` : 'Initial conceptual walkthrough.',
    relatedFiles,
    setActive: true,
  });

  // Render grounded Mermaid diagram showing interdependencies with semantic styling
  const mermaidLines = [
    'flowchart LR',
    `  CALLER["Upstream Trigger / Caller"]:::entry`,
  ];
  if (primaryFile) {
    mermaidLines.push(`  subgraph Focus["${sanitizeMermaid(cleanTitle)} Boundary"]`);
    mermaidLines.push(`    P["${sanitizeMermaid(primaryFile)}"]:::core`);
    if (secondaryFile) {
      mermaidLines.push(`    S["${sanitizeMermaid(secondaryFile)}"]:::guard`);
    }
    mermaidLines.push('  end');
    mermaidLines.push('  CALLER -->|"invokes"| P');
    if (secondaryFile) {
      mermaidLines.push('  P <-->|"collaborates"| S');
    }
    relatedFiles.slice(2, 4).forEach((f, idx) => {
      mermaidLines.push(`  N${idx}["${sanitizeMermaid(f)}"]:::external`);
      mermaidLines.push(`  P -->|"depends on"| N${idx}`);
    });
  } else {
    mermaidLines.push(`  R["${sanitizeMermaid(session.repoName)}"]:::core`);
    mermaidLines.push('  CALLER -->|"enters"| R');
  }

  const diagram: VisualArtifact = {
    id: `vis_${crypto.randomUUID().slice(0, 8)}`,
    kind: 'mermaid',
    title: `How ${cleanTitle} Connects in ${session.repoName}`,
    caption: 'Grounded dependency neighborhood derived from real files inspected in this repo.',
    source: mermaidLines.join('\n'),
  };
  callbacks.recordVisual(diagram);
  callbacks.emit({ type: 'visual', visual: diagram });

  const hookParagraph =
    level === 'foundational'
      ? `Think of **${cleanTitle}** not as a lone file sitting in isolation, but as a dedicated specialist on the team. Whenever a codebase grows past a handful of scripts, ==mixing every concern together makes tiny changes ripple unpredictably==. Here in \`${session.repoName}\`, that responsibility is anchored in ${primaryFile ? `\`${primaryFile}\` (${primaryTotalLines} lines)` : 'its core module boundary'} so the rest of the system can rely on one clear contract.`
      : level === 'advanced'
        ? `Rather than treating **${cleanTitle}** as a static symbol lookup, look at the invariant boundary it enforces inside \`${session.repoName}\`. Its primary anchor sits in ${primaryFile ? `\`${primaryFile}\` (${primaryTotalLines} lines)` : 'the root codebase'}, exposing ${primarySymbols.length > 0 ? primarySymbols.slice(0, 4).map((s) => `\`${s}\``).join(', ') : 'focused internal entry points'} so ==upstream callers stay decoupled from lower-level mechanics==.`
        : `To understand **${cleanTitle}** deeply in \`${session.repoName}\`, start with the job it isolates. Its main anchor is ${primaryFile ? `\`${primaryFile}\` (${primaryTotalLines} lines)` : 'the top-level module'}, where ${primarySymbols.length > 0 ? `symbols like ${primarySymbols.slice(0, 3).map((s) => `\`${s}\``).join(', ')}` : 'its core functions'} ==give the rest of the repository a clean seam to call into==.`;

  const interdependencyParagraph = secondaryFile
    ? `Now look at the arrows in the diagram above—this is where **interdependencies** start to matter. \`${primaryFile}\` does not act alone: it collaborates closely with \`${secondaryFile}\`${secondarySymbols.length > 0 ? ` (around ${secondarySymbols.length > 0 ? secondarySymbols.slice(0, 2).map((s) => `\`${s}\``).join(' and ') : ''})` : ''}${primaryImports.length > 0 ? ` and pulls in contracts from ${primaryImports.slice(0, 3).map((i) => `\`${i}\``).join(', ')}` : ''}. Because responsibilities are split across that boundary, ==changing how inputs are validated on one side immediately affects what the other side can safely assume==.`
    : `Even when a concern centers on a single file like \`${primaryFile ?? '.'}\`, notice what it depends on${primaryImports.length > 0 ? ` (${primaryImports.slice(0, 3).map((i) => `\`${i}\``).join(', ')})` : ''} and who depends on it (${grepRes.matches.length} references found across \`${grepRes.filesSearched}\` scanned files). ==Those inbound and outbound links are the real coupling lines you feel when refactoring==.`;

  const overTimeParagraph = `Trace how this behaves **over time** during a real run: first, an upstream trigger hands raw input into ${primaryFile ? `\`${primaryFile}\`` : 'this layer'} before any downstream work starts. Next, ${primarySymbols[0] ? `\`${primarySymbols[0]}\`` : 'the entry routine'} evaluates or transforms that input and either hands a structured result forward${secondaryFile ? ` to \`${secondaryFile}\`` : ''} or rejects invalid states early. Finally, the result propagates back up to the caller, leaving the rest of the pipeline confident that the contract held throughout the lifecycle.`;

  const subtleNote = secondaryFile
    ? `> **Subtle behavior to notice:** Because \`${primaryFile}\` and \`${secondaryFile}\` share responsibility for **${cleanTitle}**, ==a change that looks harmless inside one file can quietly break an implicit ordering assumption in the other==. Always check both sides of that seam (and any callers surfaced by \`grep_search\`) before modifying behavior.`
    : `> **Subtle behavior to notice:** Look closely at the boundary at the top of \`${primaryFile ?? '.'}\`—==enforcing checks at the earliest entry point prevents downstream code from guessing whether inputs were already validated==.`;

  const takeaway = `> **Mental model to keep:** ==Treat **${cleanTitle}** as a contract boundary anchored in \`${primaryFile ?? session.repoName}\`==—understand what crosses *into* it and what guarantees come *out* of it before worrying about every line inside.`;

  return {
    text: [
      `### Understanding ${cleanTitle}`,
      '',
      hookParagraph,
      '',
      `#### How the Pieces Depend on Each Other`,
      interdependencyParagraph,
      '',
      `#### Watching It Move Over Time`,
      overTimeParagraph,
      '',
      subtleNote,
      '',
      takeaway,
    ].join('\n'),
    checkIns: [
      {
        question: primaryFile
          ? `If an upstream caller bypassed \`${primaryFile}\` and tried to jump straight to downstream logic, what safeguard or guarantee would be lost?`
          : `What problem would ripple across the repo if **${cleanTitle}** didn't isolate its responsibility?`,
        focus: 'Boundary reasoning',
      },
      {
        question: secondaryFile
          ? `Why do you think the codebase splits this across \`${primaryFile}\` and \`${secondaryFile}\` instead of merging both into one file?`
          : `If step 1 of this flow failed mid-way, what would you expect callers upstream to see?`,
        focus: 'Failure & coupling',
      },
    ],
    nextSteps: [
      {
        title: primaryFile ? `Trace callers of ${primaryFile.split('/').pop()}` : `Deepen ${cleanTitle}`,
        rationale: 'Follow upstream callers over time to see how errors and state propagate.',
        prompt: primaryFile
          ? `Walk me step-by-step through how callers interact with ${primaryFile} over time.`
          : `Go deeper on the subtle behaviors of ${cleanTitle}.`,
        kind: 'deepen',
        targetTopicId: topicId,
      },
      {
        title: 'Zoom out to System Architecture',
        rationale: `Place ${cleanTitle} inside the broader module map of ${session.repoName}.`,
        prompt: `Let's explore System Architecture to see how ${cleanTitle} connects to neighboring layers.`,
        kind: 'broaden',
        targetTopicId: makePillarTopicId('architecture'),
      },
      {
        title: 'Inspect Git Evolution & Conventions',
        rationale: 'See what historical commits and trade-offs shaped this area.',
        prompt: `Let's explore Git Evolution & Conventions for ${session.repoName}.`,
        kind: 'explore',
        targetTopicId: makePillarTopicId('evolution'),
      },
    ],
  };
}

async function buildReinforcementLesson(
  session: InternalSession,
  topicTitle: string,
  relatedFiles: string[],
  callbacks: DemoRunCallbacks
): Promise<LessonOutput> {
  const conceptVisual = await emitToolStep(
    callbacks,
    'generate_concept_visual',
    `Built clearer mental model for ${topicTitle}`,
    topicTitle,
    () =>
      generateConceptVisual(
        {
          title: `${topicTitle} — Core Mental Model`,
          metaphor: `Picture ${topicTitle} as a three-stage relay: validate at the door, transform in the middle, hand back a clean contract.`,
          caption: 'Simplified whiteboard view showing cause-and-effect before implementation syntax.',
          layout: 'pipeline',
          accent: 'emerald',
          elements: [
            { label: 'Entry Gate', role: 'Receives raw trigger & checks rules' },
            { label: topicTitle.slice(0, 22), role: 'Performs one focused transformation' },
            { label: 'Caller Contract', role: 'Returns a predictable, typed output' },
          ],
        },
        session.provider
      )
  );
  callbacks.recordVisual(conceptVisual);
  callbacks.emit({ type: 'visual', visual: conceptVisual });

  const anchor = relatedFiles[0]
    ? `Hold onto just one anchor file for now: \`${relatedFiles[0]}\`.`
    : `Hold off on individual filenames for a moment and picture the three boxes in the diagram above.`;

  return {
    text: [
      `### Reinforcing — ${topicTitle}`,
      '',
      `Let's zoom back out to the simplest possible picture. When a codebase starts feeling dense, it's almost always because we're looking at too many moving parts at once instead of following *one* clean thread from start to finish.`,
      '',
      `Look at the three boxes in the concept map above. Whenever something happens in **${topicTitle}**, the story unfolds in the same predictable rhythm over time: first, an incoming request arrives at the **Entry Gate**, where messy real-world input gets checked before anything else touches it. Second, the middle layer does one focused transformation without having to worry about how the UI or network talks to the outside world. Third, a clean, structured result comes back out so the caller knows exactly what changed. ${anchor}`,
      '',
      `> **Subtle behavior to notice:** The reason engineers separate these three steps isn't ceremony—it's because ==time and failure happen *between* steps==. If step 1 rejects bad input early, step 2 never corrupts state halfway through.`,
      '',
      `> **Mental model to keep:** ==Don't memorize files—track the baton.== Ask: *what enters, what single rule transforms it, and what guarantee leaves?*`,
    ].join('\n'),
    checkIns: [
      {
        question: `Using that 3-step relay picture, which step in **${topicTitle}** feels clearest now—and which transition still feels fuzzy?`,
        focus: 'Clarity check',
      },
    ],
    nextSteps: [
      {
        title: 'Walk Through a Concrete Flow Over Time',
        rationale: 'Follow one real file-to-file execution step by step.',
        prompt: `Let's explore Core Flows & Implementation with a simple step-by-step example.`,
        kind: 'explore',
        targetTopicId: makePillarTopicId('flows'),
      },
      {
        title: 'View System Architecture Map',
        rationale: 'See visually how top-level folders separate responsibilities.',
        prompt: `Let's explore System Architecture with a clear diagram.`,
        kind: 'broaden',
        targetTopicId: makePillarTopicId('architecture'),
      },
      {
        title: 'Revisit Repo Purpose & Domain',
        rationale: 'Re-anchor the big picture of what this project solves.',
        prompt: `Let's revisit Repo Purpose & Domain.`,
        kind: 'revisit',
        targetTopicId: makePillarTopicId('purpose'),
      },
    ],
  };
}

async function buildPillarLesson(
  session: InternalSession,
  pillar: CorePillarId,
  level: UserLevel,
  callbacks: DemoRunCallbacks
): Promise<LessonOutput> {
  const stageNum = PILLAR_TO_STAGE[pillar];
  session.currentStage = stageNum;

  if (pillar === 'recon' || pillar === 'purpose') {
    const recon = session.rootRecon;
    const dirs = recon.topLevelEntries.filter((e) => e.type === 'dir').map((e) => e.name);
    const manifests = recon.manifests.map((m) => m.path);

    const conceptVisual = await emitToolStep(
      callbacks,
      'generate_concept_visual',
      `Created domain mental model for ${recon.repoName}`,
      recon.repoName,
      () =>
        generateConceptVisual(
          {
            title: `${recon.repoName} — Why This System Exists`,
            metaphor: `Root configs define the rules of the workshop; top-level directories separate the craftsmen so each layer stays focused.`,
            caption: 'Domain boundaries inferred directly from repository root artifacts.',
            layout: 'layers',
            accent: 'cobalt',
            elements: [
              { label: manifests[0] ?? 'Root Contracts', role: 'Build scripts, toolchain & dependency boundaries' },
              { label: dirs[0] ? `${dirs[0]}/` : 'Core Source', role: 'Primary runtime architecture & domain behavior' },
              { label: recon.repoName, role: recon.detectedStack.slice(0, 3).join(' · ') || 'Delivered product surface' },
            ],
          },
          session.provider
        )
    );
    callbacks.recordVisual(conceptVisual);
    callbacks.emit({ type: 'visual', visual: conceptVisual });

    upsertTopicMastery(session.learning, {
      id: makePillarTopicId('purpose'),
      title: ONBOARDING_STAGES[1].title,
      pillarId: 'purpose',
      mastery: 'introduced',
      notes: `Explored purpose at ${level} depth.`,
      relatedFiles: [recon.readmePath, ...manifests].filter(Boolean) as string[],
      setActive: true,
    });
    session.currentStage = 1;

    const readmeSummary = recon.readmeExcerpt
      ? recon.readmeExcerpt
          .split('\n')
          .map((l) => l.replace(/^\s*\d+\s*\|\s*/, '').trim())
          .filter((l) => l.length > 0 && !l.startsWith('![') && !l.startsWith('#'))
          .slice(0, 3)
          .join(' ')
      : `Even without a root README, the root manifests and layout tell a clear story about what \`${recon.repoName}\` is built to do.`;

    const framing =
      level === 'foundational'
        ? `Before touching any source code, think of \`${recon.repoName}\` like a well-organized workshop. At the entrance sit the blueprint and tool lists—files like ${manifests.slice(0, 3).map((m) => `\`${m}\``).join(', ') || 'the root configs'}—which tell any machine how to assemble and verify the project. Behind that door sit focused workspaces (${dirs.slice(0, 4).map((d) => `\`${d}/\``).join(', ') || 'the main source files'}) where the real runtime behavior lives.`
        : level === 'advanced'
          ? `Looking at \`${recon.repoName}\` from an architectural boundary lens, the root layer pins build, type, and dependency contracts (${manifests.slice(0, 3).map((m) => `\`${m}\``).join(', ') || 'root configs'}) while isolating runtime and verification concerns under ${dirs.slice(0, 4).map((d) => `\`${d}/\``).join(', ') || 'top-level source files'}. That split establishes clear ownership between *environment orchestration* and *domain logic*.`
          : `At a conceptual level, \`${recon.repoName}\` draws its first big boundary right at the repository root: manifest and toolchain configs (${manifests.slice(0, 3).map((m) => `\`${m}\``).join(', ') || 'root files'}) declare the runtime contracts, while directories like ${dirs.slice(0, 4).map((d) => `\`${d}/\``).join(', ') || 'its core files'} carry the application logic and tests.`;

    return {
      text: [
        `### What \`${recon.repoName}\` Exists to Solve`,
        '',
        `${readmeSummary} *(Grounded directly in your local repository at **${level}** depth.)*`,
        '',
        `#### The First Boundary That Matters`,
        framing,
        '',
        `Notice how those pieces depend on one another as soon as you boot or change the project: root manifests decide which packages, compilers, and test runners wake up first, and only *after* that shell is wired does control flow into ${dirs[0] ? `\`${dirs[0]}/\`` : 'the main implementation'}. In other words, ==root configuration actively defines the rules under which every downstream module runs==.`,
        '',
        `> **Subtle behavior to notice:** Many newcomers jump straight into deep source files and get confused by imports, path aliases, or runtime assumptions that are actually governed by root manifests like ${manifests[0] ? `\`${manifests[0]}\`` : 'the root config'}. ==Reading the root contracts first saves hours of mystery later.==`,
        '',
        `> **Mental model to keep:** ==Root files set the **rules of engagement**== (${recon.detectedStack.slice(0, 3).join(', ') || 'toolchain & build'}); ==top-level folders carry the **domain behavior** that operates inside those rules.==`,
      ].join('\n'),
      checkIns: [
        {
          question: `If you changed a dependency or compiler rule at the root of \`${recon.repoName}\`, why would that ripple differently than editing a file inside ${dirs[0] ? `\`${dirs[0]}/\`` : 'a single module'}?`,
          focus: 'Blast radius',
        },
        {
          question: dirs[0]
            ? `Between mapping how modules connect across \`${dirs[0]}/\` or tracing one concrete execution flow, which helps your goal more right now?`
            : `Which capability of \`${recon.repoName}\` do you want to understand deeply first?`,
          focus: 'Learning path',
        },
      ],
      nextSteps: [
        {
          title: 'Map System Architecture',
          rationale: 'See how major directories depend on one another in a visual component map.',
          prompt: `Let's explore System Architecture for ${recon.repoName}.`,
          kind: 'broaden',
          targetTopicId: makePillarTopicId('architecture'),
        },
        {
          title: dirs[0] ? `Dive into \`${dirs[0]}/\`` : 'Trace a Core Flow',
          rationale: 'Follow how code inside the main workspace interacts over time.',
          prompt: dirs[0]
            ? `Teach me about ${dirs[0]} and how its modules depend on each other.`
            : `Let's explore Core Flows & Implementation.`,
          kind: 'deepen',
          targetTopicId: dirs[0] ? makeCustomTopicId(dirs[0]) : makePillarTopicId('flows'),
        },
        {
          title: 'Inspect Git Evolution & Decisions',
          rationale: 'Trace how the repository evolved and which files change together.',
          prompt: `Let's explore Git Evolution & Conventions.`,
          kind: 'explore',
          targetTopicId: makePillarTopicId('evolution'),
        },
      ],
    };
  }

  if (pillar === 'architecture') {
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

    const diagramLines = [
      'flowchart TD',
      `  ROOT["${sanitizeMermaid(session.repoName)}\\nRoot Manifests & Contracts"]:::entry`,
    ];
    if (topDirs.length > 0) {
      diagramLines.push('  subgraph Modules["Top-Level Module Boundaries"]');
      topDirs.forEach((dir, idx) => {
        const nodeId = `M${idx}`;
        const children = secondLevelByParent.get(dir.name) ?? [];
        const suffix = children.length > 0 ? `\\n${children.slice(0, 3).join(' · ')}` : '';
        const roleClass = /test|spec|e2e/i.test(dir.name)
          ? 'guard'
          : /doc|asset|public|static/i.test(dir.name)
            ? 'external'
            : /data|db|store|model|schema|shared/i.test(dir.name)
              ? 'data'
              : 'core';
        diagramLines.push(`    ${nodeId}["${sanitizeMermaid(`${dir.name}/${suffix}`)}"]:::${roleClass}`);
      });
      diagramLines.push('  end');
      topDirs.forEach((dir, idx) => {
        const verb = /test|spec/i.test(dir.name) ? 'verifies' : 'organizes';
        diagramLines.push(`  ROOT -->|"${verb}"| M${idx}`);
      });
    } else {
      tree.entries
        .filter((e) => e.depth === 1)
        .slice(0, 5)
        .forEach((f, idx) => {
          diagramLines.push(`  F${idx}["${sanitizeMermaid(f.name)}"]:::core`);
          diagramLines.push(`  ROOT --> F${idx}`);
        });
    }

    const diagram: VisualArtifact = {
      id: `vis_${crypto.randomUUID().slice(0, 8)}`,
      kind: 'mermaid',
      title: `${session.repoName} — Architectural Boundaries`,
      caption: 'Module hierarchy grounded in real depth-3 repository inspection.',
      source: diagramLines.join('\n'),
    };
    callbacks.recordVisual(diagram);
    callbacks.emit({ type: 'visual', visual: diagram });

    upsertTopicMastery(session.learning, {
      id: makePillarTopicId('architecture'),
      title: ONBOARDING_STAGES[2].title,
      pillarId: 'architecture',
      mastery: 'introduced',
      notes: `Mapped ${topDirs.length} top-level module boundaries.`,
      relatedFiles: topDirs.map((d) => d.path),
      setActive: true,
    });

    const firstDir = topDirs[0]?.name;
    const secondDir = topDirs[1]?.name;
    const firstChildren = firstDir ? secondLevelByParent.get(firstDir) ?? [] : [];

    const narrativeParts = topDirs.length > 0
      ? `Look closely at the diagram above. Rather than treating every folder as equal, notice the hierarchy of responsibility: \`${firstDir}/\`${firstChildren.length > 0 ? ` subdivides further into ${firstChildren.map((c) => `\`${c}\``).join(', ')}` : ' houses core implementation code'}${secondDir ? `, while \`${secondDir}/\` sits alongside it as a separate boundary so changes can be verified or deployed without entangling concerns` : ''}.`
      : `Look at the compact layout in the diagram above—\`${session.repoName}\` keeps its modules close to the root, prioritizing low ceremony and direct file-to-file imports over deep folder nesting.`;

    const depthLens =
      level === 'foundational'
        ? `Why do engineers split code into folders like this instead of one big file? Because every folder acts as a firewall for your attention: when you're working inside one box in the diagram, you only need to understand the *contracts* coming from neighboring boxes, not their private internals.`
        : level === 'advanced'
          ? `The key architectural question in this layout is **dependency direction**: shared contracts and pure domain helpers should sit beneath orchestration and UI/IO layers so business logic stays testable without booting external runtime shells.`
          : `What turns a folder tree into real architecture is **dependency direction**: lower-level utilities and shared types stay stable while outer entry points compose them to handle live requests or user actions.`;

    return {
      text: [
        `### How \`${session.repoName}\` Is Architected`,
        '',
        depthLens,
        '',
        `#### Following the Boundaries & Interdependencies`,
        narrativeParts,
        '',
        `When a feature runs over time, execution typically enters through an outer shell, crosses into the core modules inside ${firstDir ? `\`${firstDir}/\`` : 'the primary source directory'}, and relies on shared definitions so both sides agree on data shapes. If you ever need to trace a bug, start at the boundary where external input enters and follow the dependency arrows inward.`,
        '',
        `> **Subtle behavior to notice:** ==Folder structure shows *intended* architecture, while actual imports show *real* coupling.== Whenever two sibling modules start importing from each other in both directions, subtle initialization order bugs and painful refactors appear—that's why spotting shared contract layers early is so valuable.`,
        '',
        `> **Mental model to keep:** ==Read the diagram as **layers of stability**==—outer modules handle changing inputs and presentation, while inner modules guard core rules and invariants.`,
      ].join('\n'),
      checkIns: [
        {
          question: `If you had to add a new behavior to \`${session.repoName}\`, which boundary in the diagram would own the core rule versus the user-facing trigger—and why?`,
          focus: 'Layer placement',
        },
        {
          question: `What subtle problem happens over time if two sibling modules start importing directly from each other in a cycle?`,
          focus: 'Coupling & cycles',
        },
      ],
      nextSteps: [
        {
          title: 'Trace a Core Flow Over Time',
          rationale: 'Watch a real entry point execute step-by-step across these boundaries.',
          prompt: `Let's explore Core Flows & Implementation.`,
          kind: 'deepen',
          targetTopicId: makePillarTopicId('flows'),
        },
        {
          title: firstDir ? `Deep-dive into \`${firstDir}/\`` : 'Inspect Git Evolution',
          rationale: firstDir
            ? `Inspect real files inside ${firstDir}/ and trace their interdependencies.`
            : 'See how the codebase evolved in git history.',
          prompt: firstDir
            ? `Teach me about ${firstDir} and how its files interact.`
            : `Let's explore Git Evolution & Conventions.`,
          kind: 'explore',
          targetTopicId: firstDir ? makeCustomTopicId(firstDir) : makePillarTopicId('evolution'),
        },
        {
          title: 'Explore Git Evolution & Conventions',
          rationale: 'Learn why these boundaries look the way they do from real commits.',
          prompt: `Let's explore Git Evolution & Conventions.`,
          kind: 'broaden',
          targetTopicId: makePillarTopicId('evolution'),
        },
      ],
    };
  }

  if (pillar === 'flows') {
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

    let inspectedPath = preferred?.path ?? 'README.md';
    let symbols: string[] = [];
    let imports: string[] = [];
    let totalLines = 0;

    if (preferred) {
      const fileData = await emitToolStep(
        callbacks,
        'read_file',
        `Inspected entry point ${preferred.path} (L1-60)`,
        preferred.path,
        () => readFileSlice(session.repoPath, { path: preferred.path, startLine: 1, endLine: 60 })
      );
      session.observedFiles.add(fileData.path);
      inspectedPath = fileData.path;
      totalLines = fileData.totalLines;
      symbols = extractSymbolNames(fileData.content);
      imports = extractImportTargets(fileData.content);
    }

    const flowDiagram: VisualArtifact = {
      id: `vis_${crypto.randomUUID().slice(0, 8)}`,
      kind: 'mermaid',
      title: `Runtime Story Over Time — ${inspectedPath}`,
      caption: 'End-to-end execution lifecycle anchored to an actual inspected entry point.',
      source: [
        'sequenceDiagram',
        '  autonumber',
        '  participant Caller as External Trigger',
        `  participant Entry as ${sanitizeMermaid(inspectedPath)}`,
        '  participant Core as Delegated Modules',
        '  Caller->>+Entry: Sends request / starts execution',
        '  Note over Entry: Validates boundary & builds context',
        '  Entry->>+Core: Delegates focused domain work',
        '  Core-->>-Entry: Returns structured result or error',
        '  Entry-->>-Caller: Emits final response & updates state',
      ].join('\n'),
    };
    callbacks.recordVisual(flowDiagram);
    callbacks.emit({ type: 'visual', visual: flowDiagram });

    upsertTopicMastery(session.learning, {
      id: makePillarTopicId('flows'),
      title: ONBOARDING_STAGES[3].title,
      pillarId: 'flows',
      mastery: 'introduced',
      notes: `Traced entry point ${inspectedPath} over time.`,
      relatedFiles: [inspectedPath],
      setActive: true,
    });

    const importStory =
      imports.length > 0
        ? `Notice its import list right at the top: it pulls together ${imports.slice(0, 4).map((i) => `\`${i}\``).join(', ')}. That immediately tells you \`${inspectedPath}\` is a **coordinator**, not a monolith—it knows *when* to call its neighbors rather than burying all domain rules inline.`
        : `Even in its first ${Math.min(totalLines, 60)} lines, you can see how \`${inspectedPath}\` acts as the front door that wires incoming triggers into focused operations.`;

    const symbolStory =
      symbols.length > 0
        ? `Concretely, watch what happens as execution steps through ${symbols.slice(0, 3).map((s) => `\`${s}\``).join(', ')}:`
        : `Concretely, trace the sequence diagram above from top to bottom:`;

    const levelTone =
      level === 'foundational'
        ? `Static diagrams show *who* exists, but real software comes alive **over time**. Think of \`${inspectedPath}\` (${totalLines} lines) as a restaurant host at the front door: it greets incoming triggers, checks what's needed, and routes the work to the right kitchen station.`
        : level === 'advanced'
          ? `To see how \`${session.repoName}\` behaves under real runtime pressure, trace control and state transitions over time starting at \`${inspectedPath}\` (${totalLines} lines). Watch where validation happens relative to side effects and how errors unwind back across the boundary.`
          : `Architecture only really clicks when you watch it move **over time**. Starting at \`${inspectedPath}\` (${totalLines} lines), let's trace one full cycle from initial trigger to completed output.`;

    return {
      text: [
        `### Watching a Core Flow Unfold Over Time`,
        '',
        levelTone,
        '',
        `#### Wiring & Interdependencies`,
        importStory,
        '',
        `#### Step-by-Step Timeline`,
        `${symbolStory} first, an external trigger enters \`${inspectedPath}\` at the boundary. Before heavy work starts, the entry layer establishes context and hands validated inputs to its collaborators. While that delegated work runs, state transitions happen inside focused modules rather than leaking everywhere—and only when the result settles does control return to the caller.`,
        '',
        `> **Subtle behavior to notice:** Pay attention to the *order* of steps 2–5 in the sequence diagram above. Whenever async work or streaming is involved, ==returning before downstream promises settle or mutating state before validation finishes creates invisible race conditions==.`,
        '',
        `> **Mental model to keep:** ==\`${inspectedPath}\` is the **choreographer**==—follow what it validates first, who it delegates to next, and how failures return to the caller.`,
      ].join('\n'),
      checkIns: [
        {
          question: `In the timeline above, what goes wrong if step 3's delegated work fails partway through and \`${inspectedPath}\` doesn't catch or report it cleanly?`,
          focus: 'Error propagation',
        },
        {
          question: `Why is it cleaner for \`${inspectedPath}\` to act as a thin choreographer instead of putting all downstream business logic directly inside it?`,
          focus: 'Separation of concerns',
        },
      ],
      nextSteps: [
        {
          title: 'Inspect Git Evolution & Conventions',
          rationale: 'See how commits shaped these entry points and what conventions to follow.',
          prompt: `Let's explore Git Evolution & Conventions.`,
          kind: 'broaden',
          targetTopicId: makePillarTopicId('evolution'),
        },
        {
          title: 'Revisit System Architecture',
          rationale: `Connect \`${inspectedPath}\` back to the full module map.`,
          prompt: `Let's revisit System Architecture with this runtime flow in mind.`,
          kind: 'revisit',
          targetTopicId: makePillarTopicId('architecture'),
        },
        {
          title: 'Probe Subtle Edge Cases',
          rationale: 'Go deeper into error handling, ordering constraints, and invariants.',
          prompt: `What are the subtle behaviors and edge cases around ${inspectedPath}?`,
          kind: 'deepen',
          targetTopicId: makePillarTopicId('flows'),
        },
      ],
    };
  }

  // Pillar: evolution
  const recon = session.rootRecon;
  let gitNarrative =
    `Because this folder doesn't have a \`.git\` history yet, we can't inspect past commits—but the file conventions and test layout still tell us how changes are meant to be structured.`;

  if (recon.isGitRepo) {
    const logRes = await emitToolStep(
      callbacks,
      'git_inspect',
      'Inspected recent commit history (git log --stat)',
      'git log',
      () => gitInspect(session.repoPath, { subcommand: 'log', args: ['-n', '6', '--stat', '--oneline'] })
    );
    for (const sha of logRes.observedCommits) session.observedCommits.add(sha);

    if (recon.recentMilestones.length > 0) {
      const latest = recon.recentMilestones[0];
      const earlier = recon.recentMilestones.slice(1, 5);
      const historyLines = earlier
        .map((m) => `- \`${m.shortHash}\` (${m.date}): ${m.subject}`)
        .join('\n');

      gitNarrative = [
        `Reading git history is like watching architectural decisions unfold in slow motion. The most recent milestone is \`${latest.shortHash}\` (*"${latest.subject}"*, ${latest.date} by ${latest.author}), showing where active evolution is focused right now.`,
        earlier.length > 0 ? `\nLooking just behind it reveals the trajectory:\n${historyLines}` : '',
        recon.topContributors.length > 0
          ? `\nActive contributors recorded in history: ${recon.topContributors.slice(0, 4).join(' · ')}.`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      // Render a clean visual milestone timeline from recent git history
      const timelineCommits = recon.recentMilestones.slice(0, 5).reverse();
      if (timelineCommits.length >= 2) {
        const timelineLines = ['flowchart LR'];
        timelineCommits.forEach((commit, idx) => {
          const isLatest = idx === timelineCommits.length - 1;
          const shortSubj =
            commit.subject.length > 34 ? `${commit.subject.slice(0, 33)}…` : commit.subject;
          const roleClass = isLatest ? 'entry' : idx === 0 ? 'external' : 'data';
          timelineLines.push(
            `  C${idx}["${sanitizeMermaid(`${commit.shortHash} · ${commit.date}\\n${shortSubj}`)}"]:::${roleClass}`
          );
          if (idx > 0) {
            timelineLines.push(`  C${idx - 1} --> C${idx}`);
          }
        });
        const evoVisual: VisualArtifact = {
          id: `vis_${crypto.randomUUID().slice(0, 8)}`,
          kind: 'mermaid',
          title: `${recon.repoName} — Recent Git Evolution`,
          caption: 'Chronological progression of recent repository milestones (read-only git log).',
          source: timelineLines.join('\n'),
        };
        callbacks.recordVisual(evoVisual);
        callbacks.emit({ type: 'visual', visual: evoVisual });
      }
    }
  }

  const nextFiles = [...session.observedFiles]
    .filter((p) => p.includes('/') || /\.(json|md|toml|yaml|yml|ts|js|py|go|rs)$/i.test(p))
    .slice(0, 5);

  upsertTopicMastery(session.learning, {
    id: makePillarTopicId('evolution'),
    title: ONBOARDING_STAGES[4].title,
    pillarId: 'evolution',
    mastery: 'introduced',
    notes: 'Reviewed git trajectory, churn signals, and next concrete files.',
    relatedFiles: nextFiles,
    setActive: true,
  });

  const filesStory =
    nextFiles.length > 0
      ? `Based on everything we've uncovered, your highest-leverage reading list next is ${nextFiles.slice(0, 4).map((f) => `\`${f}\``).join(', ')}.`
      : `Start next with \`${recon.readmePath ?? recon.manifests[0]?.path ?? '.'}\` and branch outward from there.`;

  return {
    text: [
      `### How \`${recon.repoName}\` Evolved Over Time`,
      '',
      `Codebases aren't designed all at once—they accumulate safeguards, refactors, and conventions in response to real friction. ${gitNarrative}`,
      '',
      `#### Turning History Into Your Next Reading Path`,
      `${filesStory} Notice how ==files that change together across commits reveal **hidden interdependencies**==: even when two modules don't import each other directly, changing together in git history signals a shared contract (like a backend SSE frame shape and the frontend parser that reads it).`,
      '',
      `> **Subtle behavior to notice:** High-churn files are rarely "bad code"—they're usually where product requirements evolve fastest or where edge cases were discovered in production. ==Reading their commit messages before editing protects you from re-introducing a solved bug.==`,
      '',
      `> **Mental model to keep:** ==Code shows *what* the system does today; git history reveals *why* the guardrails and boundaries were put there.==`,
    ].join('\n'),
    checkIns: [
      {
        question: `Why can two files that never import each other still be tightly coupled in practice—and how does git history reveal that?`,
        focus: 'Hidden coupling',
      },
      {
        question: `Which of the files we surfaced feels closest to the first feature, fix, or deep dive you want to explore next?`,
        focus: 'Next focus',
      },
    ],
    nextSteps: [
      {
        title: nextFiles[0] ? `Deep-dive \`${nextFiles[0]}\`` : 'Trace a Core Flow',
        rationale: 'Inspect one of the concrete high-signal files directly.',
        prompt: nextFiles[0]
          ? `Teach me about ${nextFiles[0]}—its interdependencies and subtle behaviors.`
          : `Let's explore Core Flows & Implementation.`,
        kind: 'deepen',
      },
      {
        title: 'Revisit System Architecture',
        rationale: 'Re-examine module boundaries now that you know the git trajectory.',
        prompt: `Let's revisit System Architecture.`,
        kind: 'revisit',
        targetTopicId: makePillarTopicId('architecture'),
      },
      {
        title: 'Walk Through a Runtime Flow',
        rationale: 'Trace an execution sequence step-by-step over time.',
        prompt: `Let's explore Core Flows & Implementation in more detail.`,
        kind: 'explore',
        targetTopicId: makePillarTopicId('flows'),
      },
    ],
  };
}

function extractSymbolNames(numberedContent: string): string[] {
  const names: string[] = [];
  const regex = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|def|func)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(numberedContent)) !== null) {
    if (!names.includes(match[1])) names.push(match[1]);
    if (names.length >= 6) break;
  }
  return names;
}

function extractImportTargets(numberedContent: string): string[] {
  const targets: string[] = [];
  const regex = /from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(numberedContent)) !== null) {
    const clean = match[1].replace(/^\.\//, '');
    if (!targets.includes(clean)) targets.push(clean);
    if (targets.length >= 5) break;
  }
  return targets;
}

function sanitizeMermaid(text: string): string {
  return text.replace(/"/g, "'").replace(/[<>]/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
