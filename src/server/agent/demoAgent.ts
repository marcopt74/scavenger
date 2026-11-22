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
 * Grounded local Demo Agent implementing the full non-linear, mastery-driven learning loop:
 * - Supports custom user-requested topics at any time (with real grep/tree/file inspection)
 * - Evaluates pending check-in responses to evolve mastery and steer reinforcement vs. deepening
 * - Allows non-linear navigation across all 5 core repo pillars
 * - Emits up to 3 check-in questions + 2-3 clickable next logical learning steps after each lesson
 */
export async function runDemoTurn(
  session: InternalSession,
  userMessage: string,
  callbacks: DemoRunCallbacks
): Promise<string> {
  const recalibrated = callbacks.recalibrated;

  // 1. Handle initial calibration if diagnostic isn't completed yet
  if (!session.diagnostic.completed) {
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

  // 2. Detect intent: explicit custom topic, explicit pillar, or check-in reply
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
          assessmentPreface = `> **Knowledge check-in:** Totally fair to want a clearer angle on **${currentTopic.title}** — let's reinforce the core mental model before branching out.\n\n`;
        } else {
          if (currentTopic.pillarId) {
            session.completedStages.add(PILLAR_TO_STAGE[currentTopic.pillarId]);
          }
          assessmentPreface = `> **Knowledge check-in:** Solid reasoning on **${currentTopic.title}** (mastery updated to **${assessment.newMastery}**). Let's build on that momentum.\n\n`;
        }
      }
    }
  }

  const activeLevel: UserLevel =
    session.diagnostic.inferredLevel === 'uncalibrated'
      ? 'intermediate'
      : session.diagnostic.inferredLevel;

  // 3. Route to custom topic, reinforcement, explicit pillar, or next logical unexplored pillar
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
    observedFilesCount: session.observedFiles.size,
    observedCommitsCount: session.observedCommits.size,
  });

  if (recalibrated) {
    responseText = `> *Calibrated explanation depth to **${recalibrated}**.*\n\n${responseText}`;
  } else if (assessmentPreface) {
    responseText = `${assessmentPreface}${responseText}`;
  }

  const chunks = responseText.match(/.{1,48}(\s|$)|\n+/g) ?? [responseText];
  for (const chunk of chunks) {
    callbacks.emit({ type: 'text-delta', delta: chunk });
    await sleep(8);
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
    () => grepSearch(session.repoPath, { query: searchToken, maxMatches: 18 })
  );
  for (const m of grepRes.matches) session.observedFiles.add(m.path);

  const relatedFiles = [
    ...new Set([
      ...pathMatches.filter((p) => p.type === 'file').map((p) => p.path),
      ...grepRes.matches.map((m) => m.path),
    ]),
  ].slice(0, 6);

  const primaryFile = relatedFiles[0] ?? tree.entries.find((e) => e.type === 'file')?.path;
  let inspectedExcerpt = 'No direct code match was found for that phrase, so here is how nearby modules organize related logic.';

  if (primaryFile) {
    const slice = await emitToolStep(
      callbacks,
      'read_file',
      `Read ${primaryFile} (L1-45)`,
      primaryFile,
      () => readFileSlice(session.repoPath, { path: primaryFile, startLine: 1, endLine: 45 })
    );
    session.observedFiles.add(slice.path);

    const keyLines = slice.content
      .split('\n')
      .filter((l) => /\b(export|function|class|interface|type|const|def|func|async)\b/.test(l))
      .slice(0, level === 'foundational' ? 5 : 9);

    inspectedExcerpt =
      keyLines.length > 0
        ? `Key declarations found in \`${slice.path}\` (${slice.totalLines} lines total):\n\`\`\`\n${keyLines.join('\n')}\n\`\`\``
        : `Inspected \`${slice.path}\` (${slice.totalLines} lines total).`;
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

  // Render grounded Mermaid diagram for the custom topic
  const diagramNodes = relatedFiles.length > 0 ? relatedFiles.slice(0, 4) : [session.repoName];
  const mermaidLines = ['flowchart LR', `  TOPIC["${sanitizeMermaid(cleanTitle)}"]`];
  diagramNodes.forEach((file, idx) => {
    mermaidLines.push(`  F${idx}["${sanitizeMermaid(file)}"]`);
    mermaidLines.push(`  TOPIC --> F${idx}`);
  });

  const diagram: VisualArtifact = {
    id: `vis_${crypto.randomUUID().slice(0, 8)}`,
    kind: 'mermaid',
    title: `Topic Map — ${cleanTitle}`,
    caption: 'Grounded files and touchpoints related to your requested topic.',
    source: mermaidLines.join('\n'),
  };
  callbacks.recordVisual(diagram);
  callbacks.emit({ type: 'visual', visual: diagram });

  const depthIntro =
    level === 'foundational'
      ? `Let's unpack **${cleanTitle}** from first principles inside \`${session.repoName}\` before worrying about low-level syntax.`
      : level === 'advanced'
        ? `Here is the concrete footprint of **${cleanTitle}** across \`${session.repoName}\`, focusing on boundaries and owning files.`
        : `Here is how **${cleanTitle}** is represented inside \`${session.repoName}\` based on read-only code inspection.`;

  const matchSummary =
    relatedFiles.length > 0
      ? `#### Grounded Touchpoints\n${relatedFiles.map((f) => `- \`${f}\``).join('\n')}`
      : `#### Grounded Touchpoints\n- Searched \`${grepRes.filesSearched}\` files; no exact symbol matched \`${searchToken}\`, so consider inspecting \`${primaryFile ?? '.'}\` or sharing a specific filename.`;

  return {
    text: [
      `### Topic Deep Dive — ${cleanTitle}`,
      '',
      depthIntro,
      '',
      matchSummary,
      '',
      inspectedExcerpt,
      '',
      `Reply to the quick check below so I can tailor our next step, pick a suggested follow-up, or ask about another topic.`,
    ].join('\n'),
    checkIns: [
      {
        question: primaryFile
          ? `In your own words, what responsibility does \`${primaryFile}\` hold within ${cleanTitle}?`
          : `Which part of ${cleanTitle} is most relevant to what you're trying to do in this repo?`,
        focus: 'Role & ownership',
      },
      {
        question:
          relatedFiles.length > 1
            ? `Why do you think this concern is split across \`${relatedFiles[0]}\` and \`${relatedFiles[1]}\` rather than living in one file?`
            : `Would you prefer to zoom deeper into line-by-line logic here or zoom out to how callers invoke it?`,
        focus: 'Boundary design',
      },
    ],
    nextSteps: [
      {
        title: primaryFile ? `Trace callers of ${primaryFile.split('/').pop()}` : `Deepen ${cleanTitle}`,
        rationale: 'See how inputs enter this module and what depends on it.',
        prompt: primaryFile
          ? `Go deeper and walk me through how callers interact with ${primaryFile}.`
          : `Go deeper on ${cleanTitle}.`,
        kind: 'deepen',
        targetTopicId: topicId,
      },
      {
        title: 'Zoom out to System Architecture',
        rationale: `Place ${cleanTitle} within the full module map of ${session.repoName}.`,
        prompt: `Let's explore System Architecture to see where ${cleanTitle} fits.`,
        kind: 'broaden',
        targetTopicId: makePillarTopicId('architecture'),
      },
      {
        title: 'Check Git Evolution & History',
        rationale: 'Inspect recent commits and design decisions affecting these files.',
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
    `Built simplified mental model for ${topicTitle}`,
    topicTitle,
    () =>
      generateConceptVisual({
        title: `${topicTitle} — Simpler Mental Model`,
        metaphor: `Breaking ${topicTitle} down into clear input -> core responsibility -> output steps.`,
        caption: 'Reframed concept card focused on clarity before implementation details.',
        elements: [
          { label: 'Trigger / Input', role: 'What starts the work' },
          { label: topicTitle.slice(0, 20), role: 'Core rule or transformation' },
          { label: 'Result / Boundary', role: 'What callers receive back' },
        ],
      })
  );
  callbacks.recordVisual(conceptVisual);
  callbacks.emit({ type: 'visual', visual: conceptVisual });

  const fileList =
    relatedFiles.length > 0
      ? `Keep only these anchor files in mind for now: ${relatedFiles.slice(0, 3).map((f) => `\`${f}\``).join(', ')}.`
      : `Focus first on the top-level responsibilities before diving into individual lines of code.`;

  return {
    text: [
      `### Reinforcing — ${topicTitle}`,
      '',
      `Let's strip away unnecessary jargon and anchor the mental model cleanly:`,
      '',
      `1. **Why it exists:** Every layer in \`${session.repoName}\` exists to isolate one clear job so changes in one area don't accidentally break another.`,
      `2. **How to picture it:** Use the 3-step flow in the concept map above—follow what comes *in*, what single decision or transformation happens in the middle, and what gets handed *back*.`,
      `3. **Where it lives:** ${fileList}`,
      '',
      `Let me know if this framing clicks better, or pick where you'd like to steer next.`,
    ].join('\n'),
    checkIns: [
      {
        question: `Does the input → core job → output framing make ${topicTitle} clearer? Which piece still feels fuzzy?`,
        focus: 'Clarity check',
      },
    ],
    nextSteps: [
      {
        title: 'See a Concrete Example Flow',
        rationale: 'Walk through one real end-to-end execution step by step.',
        prompt: `Let's explore Core Flows & Implementation with a simple example.`,
        kind: 'explore',
        targetTopicId: makePillarTopicId('flows'),
      },
      {
        title: 'View System Architecture Diagram',
        rationale: 'See visually how top-level folders connect.',
        prompt: `Let's explore System Architecture with a clear diagram.`,
        kind: 'broaden',
        targetTopicId: makePillarTopicId('architecture'),
      },
      {
        title: 'Revisit Repo Purpose & Domain',
        rationale: 'Anchor the big picture of what this project solves.',
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

    upsertTopicMastery(session.learning, {
      id: makePillarTopicId('purpose'),
      title: ONBOARDING_STAGES[1].title,
      pillarId: 'purpose',
      mastery: 'introduced',
      notes: `Explored purpose at ${level} depth.`,
      relatedFiles: [recon.readmePath, ...recon.manifests.map((m) => m.path)].filter(Boolean) as string[],
      setActive: true,
    });
    session.currentStage = 1;

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
        ? `Think of **\`${recon.repoName}\`** as a workspace organized around clear layers: root config files declare how the app builds and runs, while top-level folders keep separate responsibilities cleanly isolated.`
        : level === 'advanced'
          ? `At the boundary level, **\`${recon.repoName}\`** pins build/runtime contracts via ${recon.manifests.map((m) => `\`${m.path}\``).join(', ') || 'root configs'} and partitions domain concerns across ${dirs.slice(0, 5).map((d) => `\`${d}/\``).join(', ') || 'top-level files'}.`
          : `**\`${recon.repoName}\`** declares its runtime setup at the repository root (${recon.manifests.map((m) => `\`${m.path}\``).slice(0, 4).join(', ') || 'root files'}) and splits implementation concerns across ${dirs.slice(0, 5).map((d) => `\`${d}/\``).join(', ') || 'top-level files'}.`;

    return {
      text: [
        `### Repo Purpose & Domain`,
        '',
        `Calibrated to **${level}** depth *(Demo Mode — grounded directly in your local repo)*.`,
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
      ].join('\n'),
      checkIns: [
        {
          question: `Based on these boundaries, what looks like the core job of \`${recon.repoName}\` versus its supporting configuration?`,
          focus: 'Domain boundary',
        },
        {
          question: dirs[0]
            ? `Which top-level directory (like \`${dirs[0]}/\`) are you most curious to open next?`
            : `Which file or capability in \`${recon.repoName}\` matters most for your goal today?`,
          focus: 'Learning direction',
        },
      ],
      nextSteps: [
        {
          title: 'Map System Architecture',
          rationale: 'Visualize major modules and how boundaries connect across directories.',
          prompt: `Let's explore System Architecture for ${recon.repoName}.`,
          kind: 'broaden',
          targetTopicId: makePillarTopicId('architecture'),
        },
        {
          title: dirs[0] ? `Dive into \`${dirs[0]}/\`` : 'Trace Core Flows',
          rationale: 'Inspect concrete files and trace an execution flow.',
          prompt: dirs[0]
            ? `Teach me about ${dirs[0]} and how its modules work.`
            : `Let's explore Core Flows & Implementation.`,
          kind: 'deepen',
          targetTopicId: dirs[0] ? makeCustomTopicId(dirs[0]) : makePillarTopicId('flows'),
        },
        {
          title: 'Inspect Git Evolution & Conventions',
          rationale: 'See recent milestones and how the repository has evolved.',
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
      tree.entries
        .filter((e) => e.depth === 1)
        .slice(0, 5)
        .forEach((f, idx) => {
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

    upsertTopicMastery(session.learning, {
      id: makePillarTopicId('architecture'),
      title: ONBOARDING_STAGES[2].title,
      pillarId: 'architecture',
      mastery: 'introduced',
      notes: `Mapped ${topDirs.length} top-level module boundaries.`,
      relatedFiles: topDirs.map((d) => d.path),
      setActive: true,
    });

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
        ? 'Each box in the diagram above is a real top-level folder in this repository. Grouping code by responsibility lets you locate features without reading unrelated subsystems.'
        : level === 'advanced'
          ? 'Notice how toolchain/manifest contracts remain pinned at root while domain subsystems isolate inside dedicated subdirectories, limiting cross-cutting blast radius.'
          : 'The diagram above maps the actual top-level boundaries we scanned. Root configs orchestrate tooling while subdirectories isolate core modules.';

    const firstSub = topDirs[0]?.name;

    return {
      text: [`### System Architecture`, '', styleCommentary, '', `#### Major Modules & Boundaries`, moduleBullets].join('\n'),
      checkIns: [
        {
          question: `Looking at the module map, how would you summarize the separation of responsibilities between root configs and \`${firstSub ? `${firstSub}/` : 'source files'}\`?`,
          focus: 'Module boundaries',
        },
        {
          question: `If you needed to trace a user request or bug, which box in the diagram would you open first—and why?`,
          focus: 'Entry-point intuition',
        },
      ],
      nextSteps: [
        {
          title: 'Trace Core Execution Flows',
          rationale: 'Follow a concrete entry-point file and see how modules interact at runtime.',
          prompt: `Let's explore Core Flows & Implementation.`,
          kind: 'deepen',
          targetTopicId: makePillarTopicId('flows'),
        },
        {
          title: firstSub ? `Deep-dive into \`${firstSub}/\`` : 'Inspect Git Evolution',
          rationale: firstSub
            ? `Inspect the files and symbols inside ${firstSub}/ directly.`
            : 'Review recent commits and conventions.',
          prompt: firstSub
            ? `Teach me about ${firstSub} in detail.`
            : `Let's explore Git Evolution & Conventions.`,
          kind: 'explore',
          targetTopicId: firstSub ? makeCustomTopicId(firstSub) : makePillarTopicId('evolution'),
        },
        {
          title: 'Review Git Evolution & Conventions',
          rationale: 'See how these architectural boundaries evolved in commit history.',
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

    upsertTopicMastery(session.learning, {
      id: makePillarTopicId('flows'),
      title: ONBOARDING_STAGES[3].title,
      pillarId: 'flows',
      mastery: 'introduced',
      notes: `Traced entry point ${inspectedPath}.`,
      relatedFiles: [inspectedPath],
      setActive: true,
    });

    const depthCommentary =
      level === 'foundational'
        ? `When someone runs or interacts with \`${session.repoName}\`, execution enters through files like \`${inspectedPath}\` and hands off work to focused helper modules.`
        : level === 'advanced'
          ? `Starting from \`${inspectedPath}\`, note how imports define dependency direction and where boundary validation occurs before delegating into domain modules.`
          : `Starting at \`${inspectedPath}\`, we can trace how incoming inputs are wired to core modules and returned to callers.`;

    return {
      text: [`### Core Flows & Implementation`, '', depthCommentary, '', snippetNote].join('\n'),
      checkIns: [
        {
          question: `What does \`${inspectedPath}\` delegate rather than implementing directly inline?`,
          focus: 'Delegation & wiring',
        },
        {
          question: `Where in this flow would you expect validation or error handling to happen first?`,
          focus: 'Failure boundaries',
        },
      ],
      nextSteps: [
        {
          title: 'Explore Git Evolution & Conventions',
          rationale: 'Inspect commit history, conventions, and next files to read.',
          prompt: `Let's explore Git Evolution & Conventions.`,
          kind: 'broaden',
          targetTopicId: makePillarTopicId('evolution'),
        },
        {
          title: 'Revisit System Architecture',
          rationale: `Zoom back out to connect \`${inspectedPath}\` to the full module graph.`,
          prompt: `Let's revisit System Architecture with this flow in mind.`,
          kind: 'revisit',
          targetTopicId: makePillarTopicId('architecture'),
        },
        {
          title: 'Go Deeper on Implementation Details',
          rationale: 'Increase depth to examine edge cases and invariants.',
          prompt: `Go deeper on the implementation details of ${inspectedPath}.`,
          kind: 'deepen',
          targetTopicId: makePillarTopicId('flows'),
        },
      ],
    };
  }

  // Pillar: evolution
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

  upsertTopicMastery(session.learning, {
    id: makePillarTopicId('evolution'),
    title: ONBOARDING_STAGES[4].title,
    pillarId: 'evolution',
    mastery: 'introduced',
    notes: 'Reviewed git milestones and recommended next files.',
    relatedFiles: nextFiles,
    setActive: true,
  });

  return {
    text: [
      `### Git Evolution, Conventions & Next Steps`,
      '',
      gitSection,
      '',
      `#### Concrete Files to Inspect Next`,
      nextFiles.length > 0
        ? nextFiles.map((f) => `- \`${f}\``).join('\n')
        : `- Start with \`${recon.readmePath ?? recon.manifests[0]?.path ?? '.'}\``,
    ].join('\n'),
    checkIns: [
      {
        question: `Which area or file from the list above feels closest to the first change or question you want to tackle?`,
        focus: 'Actionable next focus',
      },
    ],
    nextSteps: [
      {
        title: nextFiles[0] ? `Teach me \`${nextFiles[0]}\`` : 'Trace a Core Flow',
        rationale: 'Inspect one of the recommended concrete files directly.',
        prompt: nextFiles[0]
          ? `Teach me about ${nextFiles[0]} and how it fits in.`
          : `Let's explore Core Flows & Implementation.`,
        kind: 'deepen',
      },
      {
        title: 'Revisit System Architecture',
        rationale: 'Double-check module boundaries now that you have historical context.',
        prompt: `Let's revisit System Architecture.`,
        kind: 'revisit',
        targetTopicId: makePillarTopicId('architecture'),
      },
      {
        title: 'Revisit Core Flows',
        rationale: 'Trace another execution path at deeper engineering detail.',
        prompt: `Let's explore Core Flows & Implementation in more depth.`,
        kind: 'explore',
        targetTopicId: makePillarTopicId('flows'),
      },
    ],
  };
}

function sanitizeMermaid(text: string): string {
  return text.replace(/"/g, "'").replace(/[<>]/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
