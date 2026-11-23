import { ONBOARDING_STAGES } from '../../shared/types.js';
import type {
  ChatMessage,
  CheckInQuestion,
  HandbookExportFormat,
  HandbookExportResponse,
  OnboardingStage,
  RepoCoreFlow,
  RepoEntryPoint,
  RepoModuleLayer,
  SuggestedNextStep,
  TopicMastery,
  VisualArtifact,
} from '../../shared/types.js';
import { computeTopicsProgressPercent, type InternalSession } from './sessionStore.js';

interface NormalizedModuleEntry {
  id: string;
  name: string;
  path: string;
  role: string;
  layer: RepoModuleLayer;
  fileCount: number;
  files: string[];
  dependsOnModules: string[];
  dependedOnByModules: string[];
  keySymbols: string[];
}

interface LessonUnit {
  index: number;
  id: string;
  title: string;
  stage: OnboardingStage;
  stageLabel: string;
  createdAt: string;
  userPrompt?: ChatMessage;
  assistantMessage?: ChatMessage;
}

const STAGE_LABEL_MAP = new Map<OnboardingStage, string>(
  ONBOARDING_STAGES.map((stage) => [stage.id, `Stage ${stage.id}: ${stage.title}`])
);

const MASTERY_LABELS: Record<TopicMastery, string> = {
  solid: 'Solid',
  developing: 'Developing',
  introduced: 'Introduced',
  unexplored: 'Unexplored',
};

/**
 * Escapes HTML special characters so code snippets, symbols, and file paths
 * never break the generated HTML document structure.
 */
export function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Produces a URL/filename-safe slug from a repository name.
 */
export function slugifyRepoName(repoName: string): string {
  const slug = String(repoName || 'repository')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'repository';
}

function escapeMarkdownTableCell(value: string): string {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function sanitizeSvgMarkup(svg: string): string {
  const trimmed = svg.trim();
  if (!trimmed.startsWith('<svg') && !trimmed.startsWith('<?xml')) {
    return `<pre><code>${escapeHtml(trimmed)}</code></pre>`;
  }
  return trimmed
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
}

function normalizeModules(session: InternalSession): NormalizedModuleEntry[] {
  if (session.knowledgeMap?.modules && session.knowledgeMap.modules.length > 0) {
    return session.knowledgeMap.modules.map((mod) => ({
      id: mod.id,
      name: mod.name || mod.id,
      path: mod.path,
      role: mod.role,
      layer: mod.layer,
      fileCount: mod.files.length,
      files: mod.files,
      dependsOnModules: mod.dependsOnModules ?? [],
      dependedOnByModules: mod.dependedOnByModules ?? [],
      keySymbols: mod.keySymbols ?? [],
    }));
  }

  if (session.knowledgeStatus?.modules && session.knowledgeStatus.modules.length > 0) {
    return session.knowledgeStatus.modules.map((mod) => ({
      id: mod.id,
      name: mod.name || mod.id,
      path: mod.path,
      role: mod.role,
      layer: mod.layer,
      fileCount: mod.fileCount,
      files: [],
      dependsOnModules: [],
      dependedOnByModules: [],
      keySymbols: mod.keySymbols ?? [],
    }));
  }

  return [];
}

function extractFirstHeading(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^#{1,4}\s+(.+)$/);
    if (match) {
      return match[1]
        .replace(/==/g, '')
        .replace(/[*_`~]/g, '')
        .trim();
    }
  }
  return undefined;
}

function summarizePromptTitle(content: string): string {
  const cleaned = content
    .replace(/\r?\n/g, ' ')
    .replace(/[*_`~#]/g, '')
    .trim();
  if (!cleaned) return 'Follow-up Exploration';
  return cleaned.length > 68 ? `${cleaned.slice(0, 65).trim()}...` : cleaned;
}

function groupSessionLessons(messages: ChatMessage[]): LessonUnit[] {
  const units: LessonUnit[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const current = messages[i];
    if (!current) continue;

    if (current.role === 'user') {
      const next = messages[i + 1];
      if (next && next.role === 'assistant') {
        const index = units.length + 1;
        const stage = next.stage ?? current.stage ?? 0;
        const stageLabel = STAGE_LABEL_MAP.get(stage) ?? `Stage ${stage}`;
        const title =
          next.topicTitle ||
          current.topicTitle ||
          extractFirstHeading(next.content) ||
          summarizePromptTitle(current.content) ||
          stageLabel;

        units.push({
          index,
          id: `lesson-${index}`,
          title,
          stage,
          stageLabel,
          createdAt: next.createdAt || current.createdAt,
          userPrompt: current,
          assistantMessage: next,
        });
        i += 1;
      } else {
        const index = units.length + 1;
        const stage = current.stage ?? 0;
        const stageLabel = STAGE_LABEL_MAP.get(stage) ?? `Stage ${stage}`;
        const title = current.topicTitle || summarizePromptTitle(current.content) || stageLabel;
        units.push({
          index,
          id: `lesson-${index}`,
          title,
          stage,
          stageLabel,
          createdAt: current.createdAt,
          userPrompt: current,
        });
      }
      continue;
    }

    const index = units.length + 1;
    const stage = current.stage ?? 0;
    const stageLabel = STAGE_LABEL_MAP.get(stage) ?? `Stage ${stage}`;
    const title =
      current.topicTitle ||
      extractFirstHeading(current.content) ||
      (index === 1 ? 'Initial Repository Recon & Calibration' : stageLabel);

    units.push({
      index,
      id: `lesson-${index}`,
      title,
      stage,
      stageLabel,
      createdAt: current.createdAt,
      assistantMessage: current,
    });
  }

  return units;
}

/**
 * Extracts explicit `==highlighted takeaways==` outside fenced code blocks and inline code.
 */
function extractHighlightedTakeaways(markdown: string): string[] {
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, '');
  const withoutInlineCode = withoutFences.replace(/`[^`\n]+`/g, '');
  const takeaways: string[] = [];
  const regex = /==([^\s=](?:[\s\S]*?[^\s=])?)==/g;
  let match: RegExpExecArray | null = regex.exec(withoutInlineCode);
  while (match !== null) {
    const cleaned = match[1].replace(/\s+/g, ' ').trim();
    if (cleaned && !takeaways.includes(cleaned)) {
      takeaways.push(cleaned);
    }
    match = regex.exec(withoutInlineCode);
  }
  return takeaways;
}

/**
 * Renders inline Markdown constructs (`code`, `==highlights==`, `**bold**`, `*italic*`, links)
 * into safe HTML with all underlying text HTML-escaped.
 */
function renderInlineMarkdownToHtml(text: string): string {
  const codeTokens: string[] = [];
  const withCodePlaceholders = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE_${idx}\u0000`;
  });

  const highlightTokens: string[] = [];
  const withHighlightPlaceholders = withCodePlaceholders.replace(
    /==([^\s=](?:[\s\S]*?[^\s=])?)==/g,
    (_match, inner: string) => {
      const idx = highlightTokens.length;
      const escapedInner = escapeHtml(inner)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
      highlightTokens.push(`<mark class="scavenger-highlight">${escapedInner}</mark>`);
      return `\u0000MARK_${idx}\u0000`;
    }
  );

  let html = escapeHtml(withHighlightPlaceholders);

  // Links: [label](https://...)
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // Bold & italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)"]|$)/g, '$1<em>$2</em>');

  // Restore highlights first (since highlights may contain code placeholders)
  html = html.replace(/\u0000MARK_(\d+)\u0000/g, (_m, indexStr: string) => {
    return highlightTokens[Number(indexStr)] ?? '';
  });

  // Restore inline code
  html = html.replace(/\u0000CODE_(\d+)\u0000/g, (_m, indexStr: string) => {
    return codeTokens[Number(indexStr)] ?? '';
  });

  return html;
}

/**
 * Converts Markdown prose (headings, lists, blockquotes, tables, code fences, and inline `==...==` highlights)
 * into clean, escaped HTML for the self-contained handbook.
 */
function renderMarkdownToHtml(markdown: string): string {
  if (!markdown || !markdown.trim()) {
    return '';
  }

  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fenceMatch = line.match(/^```([a-zA-Z0-9_-]*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || 'text';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        i += 1; // skip closing fence
      }
      const rawCode = codeLines.join('\n');
      if (lang.toLowerCase() === 'mermaid') {
        blocks.push(
          `<div class="inline-mermaid-block"><pre class="mermaid">${escapeHtml(rawCode)}</pre></div>`
        );
      } else {
        blocks.push(
          `<pre class="code-block" data-lang="${escapeHtml(lang)}"><code>${escapeHtml(rawCode)}</code></pre>`
        );
      }
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push('<hr />');
      i += 1;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(6, Math.max(2, headingMatch[1].length + 1));
      blocks.push(`<h${level}>${renderInlineMarkdownToHtml(headingMatch[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // Markdown table
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])
    ) {
      const parseRow = (rowLine: string): string[] =>
        rowLine
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim());

      const headers = parseRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(parseRow(lines[i]));
        i += 1;
      }

      const thead = `<thead><tr>${headers
        .map((h) => `<th>${renderInlineMarkdownToHtml(h)}</th>`)
        .join('')}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map(
          (row) =>
            `<tr>${headers
              .map((_h, colIdx) => `<td>${renderInlineMarkdownToHtml(row[colIdx] ?? '')}</td>`)
              .join('')}</tr>`
        )
        .join('')}</tbody>`;
      blocks.push(`<div class="table-wrap"><table class="prose-table">${thead}${tbody}</table></div>`);
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push(
        `<blockquote>${quoteLines
          .map((q) => `<p>${renderInlineMarkdownToHtml(q)}</p>`)
          .join('')}</blockquote>`
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push(
        `<ul>${items.map((item) => `<li>${renderInlineMarkdownToHtml(item)}</li>`).join('')}</ul>`
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push(
        `<ol>${items.map((item) => `<li>${renderInlineMarkdownToHtml(item)}</li>`).join('')}</ol>`
      );
      continue;
    }

    // Paragraph
    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i].trim())
    ) {
      paragraphLines.push(lines[i].trim());
      i += 1;
    }
    if (paragraphLines.length > 0) {
      blocks.push(`<p>${renderInlineMarkdownToHtml(paragraphLines.join(' '))}</p>`);
    }
  }

  return blocks.join('\n');
}

function renderVisualMarkdown(visual: VisualArtifact): string {
  const lines: string[] = [];

  if (visual.kind === 'mermaid') {
    lines.push(`#### Diagram: ${visual.title}`);
    if (visual.caption) {
      lines.push(`*${visual.caption}*`);
    }
    lines.push('');
    lines.push('```mermaid');
    lines.push(visual.source.trim());
    lines.push('```');
    return lines.join('\n');
  }

  if (visual.kind === 'd2') {
    lines.push(`#### Architecture Diagram (D2): ${visual.title}`);
    if (visual.caption) {
      lines.push(`*${visual.caption}*`);
    }
    lines.push('');
    lines.push('```d2');
    lines.push(visual.source.trim());
    lines.push('```');
    return lines.join('\n');
  }

  lines.push(`#### Concept Visual: ${visual.title}`);
  if (visual.caption) {
    lines.push(`*${visual.caption}*`);
  }
  if (visual.metaphor) {
    lines.push(`- **Mental Model / Metaphor:** ${visual.metaphor}`);
  }
  if (visual.layout) {
    lines.push(`- **Layout Pattern:** \`${visual.layout}\``);
  }
  if (visual.elements && visual.elements.length > 0) {
    lines.push('- **Key Elements:**');
    for (const element of visual.elements) {
      lines.push(`  - **${element.label}**: ${element.role}`);
    }
  }
  return lines.join('\n');
}

function renderVisualHtml(visual: VisualArtifact): string {
  const captionHtml = visual.caption
    ? `<figcaption class="visual-caption">${escapeHtml(visual.caption)}</figcaption>`
    : '';

  if (visual.kind === 'mermaid') {
    const escapedSource = escapeHtml(visual.source.trim());
    return [
      `<figure class="visual-card visual-mermaid">`,
      `  <div class="visual-card-header">`,
      `    <span class="visual-badge badge-mermaid">Mermaid Diagram</span>`,
      `    <h4 class="visual-title">${escapeHtml(visual.title)}</h4>`,
      `  </div>`,
      `  <div class="mermaid-viewport">`,
      `    <pre class="mermaid">${escapedSource}</pre>`,
      `  </div>`,
      captionHtml,
      `  <details class="diagram-source-details">`,
      `    <summary>Diagram Source</summary>`,
      `    <pre class="code-block"><code>${escapedSource}</code></pre>`,
      `  </details>`,
      `</figure>`,
    ].join('\n');
  }

  if (visual.kind === 'd2') {
    const escapedSource = escapeHtml(visual.source.trim());
    const svgHtml = visual.svgMarkup
      ? `<div class="visual-svg-container">${sanitizeSvgMarkup(visual.svgMarkup)}</div>`
      : '';
    return [
      `<figure class="visual-card visual-d2">`,
      `  <div class="visual-card-header">`,
      `    <span class="visual-badge badge-d2">D2 Architecture Diagram</span>`,
      `    <h4 class="visual-title">${escapeHtml(visual.title)}</h4>`,
      `  </div>`,
      svgHtml,
      captionHtml,
      `  <details class="diagram-source-details"${visual.svgMarkup ? '' : ' open'}>`,
      `    <summary>Diagram Source</summary>`,
      `    <pre class="code-block"><code>${escapedSource}</code></pre>`,
      `  </details>`,
      `</figure>`,
    ].join('\n');
  }

  // concept-image
  const mediaHtml = visual.imageDataUrl
    ? `<div class="visual-image-wrap"><img src="${escapeHtml(visual.imageDataUrl)}" alt="${escapeHtml(visual.title)}" loading="lazy" /></div>`
    : visual.svgMarkup
      ? `<div class="visual-svg-container">${sanitizeSvgMarkup(visual.svgMarkup)}</div>`
      : '';

  const metaphorHtml = visual.metaphor
    ? `<p class="concept-metaphor"><strong>Metaphor:</strong> ${escapeHtml(visual.metaphor)}</p>`
    : '';

  const elementsHtml =
    visual.elements && visual.elements.length > 0
      ? `<div class="concept-elements-grid">${visual.elements
          .map(
            (el) =>
              `<div class="concept-element-item"><strong>${escapeHtml(el.label)}</strong><span>${escapeHtml(el.role)}</span></div>`
          )
          .join('')}</div>`
      : '';

  return [
    `<figure class="visual-card visual-concept">`,
    `  <div class="visual-card-header">`,
    `    <span class="visual-badge badge-concept">Concept Illustration</span>`,
    `    <h4 class="visual-title">${escapeHtml(visual.title)}</h4>`,
    `  </div>`,
    mediaHtml,
    `  <div class="concept-structured-body">`,
    metaphorHtml,
    elementsHtml,
    `  </div>`,
    captionHtml,
    `</figure>`,
  ].join('\n');
}

function renderCheckInMarkdown(questions: CheckInQuestion[]): string {
  if (!questions || questions.length === 0) return '';
  const lines: string[] = ['#### Quick Check Questions', ''];
  for (const q of questions) {
    lines.push(`- **[${q.focus}]** ${q.question}`);
  }
  return lines.join('\n');
}

function renderSuggestedStepsMarkdown(steps: SuggestedNextStep[]): string {
  if (!steps || steps.length === 0) return '';
  const lines: string[] = ['#### Suggested Next Steps', ''];
  for (const step of steps) {
    lines.push(`- **${step.title}** (\`${step.kind}\`) — ${step.rationale}`);
    lines.push(`  - *Prompt:* \`${step.prompt}\``);
  }
  return lines.join('\n');
}

function renderCheckInHtml(questions: CheckInQuestion[]): string {
  if (!questions || questions.length === 0) return '';
  return [
    `<div class="lesson-callout checkin-card">`,
    `  <div class="callout-header">Quick Check &amp; Self-Verification</div>`,
    `  <ul class="checkin-list">`,
    ...questions.map(
      (q) =>
        `    <li><span class="focus-chip">${escapeHtml(q.focus)}</span><span>${escapeHtml(q.question)}</span></li>`
    ),
    `  </ul>`,
    `</div>`,
  ].join('\n');
}

function renderSuggestedStepsHtml(steps: SuggestedNextStep[]): string {
  if (!steps || steps.length === 0) return '';
  return [
    `<div class="lesson-callout next-steps-card">`,
    `  <div class="callout-header">Suggested Next Explorations</div>`,
    `  <div class="next-steps-grid">`,
    ...steps.map(
      (s) =>
        `    <div class="next-step-item">` +
        `<div class="next-step-top"><span class="step-kind-badge">${escapeHtml(s.kind)}</span><strong>${escapeHtml(s.title)}</strong></div>` +
        `<p class="next-step-rationale">${escapeHtml(s.rationale)}</p>` +
        `<code class="next-step-prompt">${escapeHtml(s.prompt)}</code>` +
        `</div>`
    ),
    `  </div>`,
    `</div>`,
  ].join('\n');
}

function generateMarkdownHandbook(session: InternalSession, generatedAt: string): string {
  const repoName = session.repoName || 'Repository';
  const branch =
    session.knowledgeMap?.branch ||
    session.knowledgeStatus?.branch ||
    session.rootRecon?.branch ||
    (session.rootRecon?.isGitRepo ? 'HEAD' : 'N/A');
  const headCommit =
    session.knowledgeMap?.headCommit ||
    session.knowledgeStatus?.headCommit ||
    session.rootRecon?.recentMilestones?.[0]?.shortHash ||
    'N/A';
  const stack =
    session.rootRecon?.detectedStack && session.rootRecon.detectedStack.length > 0
      ? session.rootRecon.detectedStack.join(', ')
      : 'Unspecified';
  const inferredLevel = session.diagnostic?.inferredLevel || 'uncalibrated';
  const observedFilesCount = session.observedFiles ? session.observedFiles.size : 0;
  const observedCommitsCount = session.observedCommits ? session.observedCommits.size : 0;
  const purpose =
    session.knowledgeMap?.summary?.purpose ||
    session.rootRecon?.readmeExcerpt ||
    'Synthesized during interactive repository onboarding.';
  const architectureOverview =
    session.knowledgeMap?.summary?.architectureOverview ||
    'Architecture boundaries mapped from root recon and module dependency analysis.';

  const topics = session.learning?.topics ?? [];
  const overallMasteryPercent = computeTopicsProgressPercent(topics);
  const solidCount = topics.filter((t) => t.mastery === 'solid').length;
  const exploredCount = topics.filter((t) => t.mastery !== 'unexplored').length;

  const modules = normalizeModules(session);
  const entryPoints: RepoEntryPoint[] =
    session.knowledgeMap?.summary?.entryPoints ?? session.knowledgeStatus?.entryPoints ?? [];
  const coreFlows: RepoCoreFlow[] =
    session.knowledgeMap?.summary?.coreFlows ?? session.knowledgeStatus?.coreFlows ?? [];
  const conventions: string[] = session.knowledgeMap?.summary?.conventions ?? [];
  const lessons = groupSessionLessons(session.messages ?? []);

  const sections: string[] = [];

  // 1. Header & Executive Summary
  sections.push(
    [
      `# ${repoName} — Onboarding Handbook & Architecture Study Guide`,
      '',
      `> Generated by **Scavenger** on \`${generatedAt}\`  `,
      `> **Canonical Path:** \`${session.repoPath}\`  `,
      `> **Git Branch / HEAD:** \`${branch}\` @ \`${headCommit}\`  `,
      `> **Detected Stack:** ${stack}  `,
      `> **Explanation Depth:** \`${inferredLevel}\` | **Overall Mastery:** **${overallMasteryPercent}%** (${solidCount}/${topics.length} solid, ${exploredCount}/${topics.length} explored)  `,
      `> **Grounded Evidence:** ${observedFilesCount} files inspected · ${observedCommitsCount} git commits examined`,
      '',
      '## Table of Contents',
      '- [Executive Summary & Repository Purpose](#executive-summary--repository-purpose)',
      '- [Mastery & Topics Progress](#mastery--topics-progress)',
      '- [Architecture Module Directory](#architecture-module-directory)',
      '- [Entry Points & Core Execution Flows](#entry-points--core-execution-flows)',
      '- [Curated Whiteboard Lessons & Walkthroughs](#curated-whiteboard-lessons--walkthroughs)',
      ...lessons.map((l) => `  - [Lesson ${l.index}: ${l.title}](#${l.id})`),
      '',
      '---',
      '',
      '## Executive Summary & Repository Purpose',
      '',
      '### Repository Purpose',
      purpose.trim(),
      '',
      '### Architecture Overview',
      architectureOverview.trim(),
      ...(session.diagnostic?.goal
        ? ['', `**Onboarding Goal:** ${session.diagnostic.goal}`]
        : []),
      ...(session.learning?.lastAssessmentSummary
        ? ['', `**Latest Mentor Assessment:** ${session.learning.lastAssessmentSummary}`]
        : []),
    ].join('\n')
  );

  // 2. Mastery & Topics Progress Table
  const topicRows =
    topics.length > 0
      ? topics.map((topic) => {
          const relatedFiles =
            topic.relatedFiles && topic.relatedFiles.length > 0
              ? topic.relatedFiles.map((f) => `\`${f}\``).join(', ')
              : '—';
          const notes = topic.notes ? escapeMarkdownTableCell(topic.notes) : '—';
          return `| ${escapeMarkdownTableCell(topic.title)} | \`${topic.kind}\` | **${MASTERY_LABELS[topic.mastery] ?? topic.mastery}** | ${ escapeMarkdownTableCell(relatedFiles) } | ${notes} |`;
        })
      : ['| *No topics recorded* | — | — | — | — |'];

  sections.push(
    [
      '## Mastery & Topics Progress',
      '',
      `**Overall Mastery Score:** **${overallMasteryPercent}%** (${solidCount} solid, ${exploredCount} explored out of ${topics.length} topics)`,
      '',
      '| Topic | Kind | Mastery | Related Files | Notes |',
      '| :--- | :--- | :--- | :--- | :--- |',
      ...topicRows,
    ].join('\n')
  );

  // 3. Architecture Module Directory
  const moduleSectionLines: string[] = ['## Architecture Module Directory', ''];
  if (modules.length === 0) {
    moduleSectionLines.push('*No indexed architecture modules available for this session.*');
  } else {
    moduleSectionLines.push(
      '| Module ID | Layer | Role | Files | Depends On | Depended On By | Key Symbols |',
      '| :--- | :--- | :--- | ---: | :--- | :--- | :--- |'
    );
    for (const mod of modules) {
      const deps =
        mod.dependsOnModules.length > 0
          ? mod.dependsOnModules.map((d) => `\`${d}\``).join(', ')
          : '—';
      const revDeps =
        mod.dependedOnByModules.length > 0
          ? mod.dependedOnByModules.map((d) => `\`${d}\``).join(', ')
          : '—';
      const symbols =
        mod.keySymbols.length > 0
          ? mod.keySymbols.slice(0, 8).map((s) => `\`${s}\``).join(', ')
          : '—';
      moduleSectionLines.push(
        `| \`${escapeMarkdownTableCell(mod.id)}\` | \`${mod.layer}\` | ${escapeMarkdownTableCell(mod.role)} | ${mod.fileCount} | ${escapeMarkdownTableCell(deps)} | ${escapeMarkdownTableCell(revDeps)} | ${escapeMarkdownTableCell(symbols)} |`
      );
    }
  }
  sections.push(moduleSectionLines.join('\n'));

  // 4. Entry Points & Core Execution Flows
  const flowsLines: string[] = ['## Entry Points & Core Execution Flows', '', '### Entry Points'];
  if (entryPoints.length === 0) {
    flowsLines.push('*No explicit entry points indexed.*');
  } else {
    flowsLines.push('| Path | Kind | Role |', '| :--- | :--- | :--- |');
    for (const ep of entryPoints) {
      flowsLines.push(
        `| \`${escapeMarkdownTableCell(ep.path)}\` | \`${ep.kind}\` | ${escapeMarkdownTableCell(ep.role)} |`
      );
    }
  }

  flowsLines.push('', '### Core Execution Flows');
  if (coreFlows.length === 0) {
    flowsLines.push('*No core execution flows synthesized yet.*');
  } else {
    for (const flow of coreFlows) {
      flowsLines.push(`#### ${flow.name}`);
      flowsLines.push(flow.summary);
      if (flow.files && flow.files.length > 0) {
        flowsLines.push(`- **Files Involved:** ${flow.files.map((f) => `\`${f}\``).join(' → ')}`);
      }
      if (flow.steps && flow.steps.length > 0) {
        flowsLines.push('- **Execution Steps:**');
        flow.steps.forEach((step, idx) => {
          flowsLines.push(`  ${idx + 1}. ${step}`);
        });
      }
      flowsLines.push('');
    }
  }

  if (conventions.length > 0) {
    flowsLines.push('### Engineering Conventions & Invariants', '');
    for (const conv of conventions) {
      flowsLines.push(`- ${conv}`);
    }
  }
  sections.push(flowsLines.join('\n'));

  // 5. Curated Whiteboard Lessons & Walkthroughs
  const lessonsLines: string[] = ['## Curated Whiteboard Lessons & Walkthroughs', ''];
  if (lessons.length === 0) {
    lessonsLines.push('*No interactive whiteboard lessons recorded yet in this session.*');
  } else {
    for (const lesson of lessons) {
      lessonsLines.push(`<a id="${lesson.id}"></a>`);
      lessonsLines.push(`### Lesson ${lesson.index}: ${lesson.title}`);
      lessonsLines.push(`*${lesson.stageLabel} · ${lesson.createdAt}*`);
      lessonsLines.push('');

      if (lesson.userPrompt) {
        lessonsLines.push('**Developer Prompt / Question:**');
        for (const pLine of lesson.userPrompt.content.trim().split(/\r?\n/)) {
          lessonsLines.push(`> ${pLine}`);
        }
        lessonsLines.push('');
      }

      if (lesson.assistantMessage) {
        const msg = lesson.assistantMessage;
        const takeaways = extractHighlightedTakeaways(msg.content);
        if (takeaways.length > 0) {
          lessonsLines.push('> **Highlighted Key Takeaways:**');
          for (const t of takeaways) {
            lessonsLines.push(`> - ==${t}==`);
          }
          lessonsLines.push('');
        }

        lessonsLines.push(msg.content.trim());
        lessonsLines.push('');

        if (msg.visuals && msg.visuals.length > 0) {
          for (const visual of msg.visuals) {
            lessonsLines.push(renderVisualMarkdown(visual));
            lessonsLines.push('');
          }
        }

        if (msg.checkInQuestions && msg.checkInQuestions.length > 0) {
          lessonsLines.push(renderCheckInMarkdown(msg.checkInQuestions));
          lessonsLines.push('');
        }

        if (msg.suggestedNextSteps && msg.suggestedNextSteps.length > 0) {
          lessonsLines.push(renderSuggestedStepsMarkdown(msg.suggestedNextSteps));
          lessonsLines.push('');
        }
      }

      lessonsLines.push('---', '');
    }
  }
  sections.push(lessonsLines.join('\n'));

  return `${sections.join('\n\n')}\n`;
}

function generateHtmlHandbook(session: InternalSession, generatedAt: string): string {
  const repoName = session.repoName || 'Repository';
  const branch =
    session.knowledgeMap?.branch ||
    session.knowledgeStatus?.branch ||
    session.rootRecon?.branch ||
    (session.rootRecon?.isGitRepo ? 'HEAD' : 'Not a Git repo');
  const headCommit =
    session.knowledgeMap?.headCommit ||
    session.knowledgeStatus?.headCommit ||
    session.rootRecon?.recentMilestones?.[0]?.shortHash ||
    'N/A';
  const detectedStack =
    session.rootRecon?.detectedStack && session.rootRecon.detectedStack.length > 0
      ? session.rootRecon.detectedStack
      : ['Unspecified'];
  const inferredLevel = session.diagnostic?.inferredLevel || 'uncalibrated';
  const observedFilesCount = session.observedFiles ? session.observedFiles.size : 0;
  const observedCommitsCount = session.observedCommits ? session.observedCommits.size : 0;
  const observedFilesList = session.observedFiles ? [...session.observedFiles] : [];
  const purpose =
    session.knowledgeMap?.summary?.purpose ||
    session.rootRecon?.readmeExcerpt ||
    'Synthesized during interactive repository onboarding.';
  const architectureOverview =
    session.knowledgeMap?.summary?.architectureOverview ||
    'Architecture boundaries mapped from root recon and module dependency analysis.';

  const topics = session.learning?.topics ?? [];
  const overallMasteryPercent = computeTopicsProgressPercent(topics);
  const solidCount = topics.filter((t) => t.mastery === 'solid').length;
  const exploredCount = topics.filter((t) => t.mastery !== 'unexplored').length;

  const modules = normalizeModules(session);
  const entryPoints: RepoEntryPoint[] =
    session.knowledgeMap?.summary?.entryPoints ?? session.knowledgeStatus?.entryPoints ?? [];
  const coreFlows: RepoCoreFlow[] =
    session.knowledgeMap?.summary?.coreFlows ?? session.knowledgeStatus?.coreFlows ?? [];
  const conventions: string[] = session.knowledgeMap?.summary?.conventions ?? [];
  const lessons = groupSessionLessons(session.messages ?? []);

  const tocLessonsHtml =
    lessons.length > 0
      ? lessons
          .map(
            (lesson) =>
              `<a class="toc-sublink" href="#${lesson.id}" data-toc-lesson="${lesson.id}" data-filter-text="${escapeHtml(`${lesson.title} ${lesson.stageLabel}`.toLowerCase())}">` +
              `<span class="toc-lesson-num">#${lesson.index}</span>` +
              `<span>${escapeHtml(lesson.title)}</span>` +
              `</a>`
          )
          .join('\n')
      : '<span class="toc-empty">No lessons yet</span>';

  const stackChipsHtml = detectedStack
    .map((item) => `<span class="stack-chip">${escapeHtml(item)}</span>`)
    .join('');

  const topicsRowsHtml =
    topics.length > 0
      ? topics
          .map((topic) => {
            const filesHtml =
              topic.relatedFiles && topic.relatedFiles.length > 0
                ? topic.relatedFiles
                    .map((file) => `<code class="file-pill">${escapeHtml(file)}</code>`)
                    .join(' ')
                : '<span class="muted">—</span>';
            const notesHtml = topic.notes
              ? escapeHtml(topic.notes)
              : '<span class="muted">—</span>';
            const filterText = `${topic.title} ${topic.kind} ${topic.mastery} ${(topic.relatedFiles ?? []).join(' ')} ${topic.notes ?? ''}`.toLowerCase();
            return [
              `<tr data-filterable="topic" data-filter-text="${escapeHtml(filterText)}">`,
              `  <td><strong>${escapeHtml(topic.title)}</strong></td>`,
              `  <td><span class="kind-pill kind-${escapeHtml(topic.kind)}">${escapeHtml(topic.kind)}</span></td>`,
              `  <td><span class="mastery-badge mastery-${escapeHtml(topic.mastery)}">${escapeHtml(MASTERY_LABELS[topic.mastery] ?? topic.mastery)}</span></td>`,
              `  <td>${filesHtml}</td>`,
              `  <td>${notesHtml}</td>`,
              `</tr>`,
            ].join('\n');
          })
          .join('\n')
      : '<tr><td colspan="5" class="muted">No learning topics recorded yet.</td></tr>';

  const modulesCardsHtml =
    modules.length > 0
      ? modules
          .map((mod) => {
            const depsHtml =
              mod.dependsOnModules.length > 0
                ? mod.dependsOnModules
                    .map((d) => `<code class="dep-chip">${escapeHtml(d)}</code>`)
                    .join(' ')
                : '<span class="muted">None</span>';
            const dependedByHtml =
              mod.dependedOnByModules.length > 0
                ? mod.dependedOnByModules
                    .map((d) => `<code class="dep-chip">${escapeHtml(d)}</code>`)
                    .join(' ')
                : '<span class="muted">None</span>';
            const symbolsHtml =
              mod.keySymbols.length > 0
                ? mod.keySymbols
                    .map((s) => `<code class="symbol-chip">${escapeHtml(s)}</code>`)
                    .join(' ')
                : '<span class="muted">No exported symbols indexed</span>';
            const filterText = `${mod.id} ${mod.name} ${mod.layer} ${mod.role} ${mod.path} ${mod.dependsOnModules.join(' ')} ${mod.dependedOnByModules.join(' ')} ${mod.keySymbols.join(' ')}`.toLowerCase();

            return [
              `<article class="module-card" data-filterable="module" data-filter-text="${escapeHtml(filterText)}">`,
              `  <div class="module-card-top">`,
              `    <div>`,
              `      <span class="layer-badge layer-${escapeHtml(mod.layer)}">${escapeHtml(mod.layer)}</span>`,
              `      <h3 class="module-id">${escapeHtml(mod.id)}</h3>`,
              `    </div>`,
              `    <span class="file-count-pill">${mod.fileCount} file${mod.fileCount === 1 ? '' : 's'}</span>`,
              `  </div>`,
              `  <p class="module-role">${escapeHtml(mod.role)}</p>`,
              `  <div class="module-meta-grid">`,
              `    <div><span class="meta-label">Path:</span> <code>${escapeHtml(mod.path)}</code></div>`,
              `    <div><span class="meta-label">Depends On:</span> ${depsHtml}</div>`,
              `    <div><span class="meta-label">Depended On By:</span> ${dependedByHtml}</div>`,
              `    <div><span class="meta-label">Key Symbols:</span> ${symbolsHtml}</div>`,
              `  </div>`,
              `</article>`,
            ].join('\n');
          })
          .join('\n')
      : '<p class="empty-state">No architecture modules indexed in the knowledge map for this session.</p>';

  const entryPointsHtml =
    entryPoints.length > 0
      ? [
          `<div class="table-wrap">`,
          `  <table class="data-table">`,
          `    <thead><tr><th>Path</th><th>Kind</th><th>Architectural Role</th></tr></thead>`,
          `    <tbody>`,
          ...entryPoints.map((ep) => {
            const filterText = `${ep.path} ${ep.kind} ${ep.role}`.toLowerCase();
            return `<tr data-filterable="entrypoint" data-filter-text="${escapeHtml(filterText)}"><td><code>${escapeHtml(ep.path)}</code></td><td><span class="kind-pill">${escapeHtml(ep.kind)}</span></td><td>${escapeHtml(ep.role)}</td></tr>`;
          }),
          `    </tbody>`,
          `  </table>`,
          `</div>`,
        ].join('\n')
      : '<p class="empty-state">No explicit entry points recorded.</p>';

  const coreFlowsHtml =
    coreFlows.length > 0
      ? coreFlows
          .map((flow) => {
            const filesHtml =
              flow.files && flow.files.length > 0
                ? `<div class="flow-files">${flow.files
                    .map((f) => `<code class="file-pill">${escapeHtml(f)}</code>`)
                    .join('<span class="flow-arrow">→</span>')}</div>`
                : '';
            const stepsHtml =
              flow.steps && flow.steps.length > 0
                ? `<ol class="flow-steps">${flow.steps
                    .map((s) => `<li>${escapeHtml(s)}</li>`)
                    .join('')}</ol>`
                : '';
            const filterText = `${flow.name} ${flow.summary} ${(flow.files ?? []).join(' ')} ${(flow.steps ?? []).join(' ')}`.toLowerCase();
            return [
              `<article class="flow-card" data-filterable="flow" data-filter-text="${escapeHtml(filterText)}">`,
              `  <h4 class="flow-title">${escapeHtml(flow.name)}</h4>`,
              `  <p class="flow-summary">${escapeHtml(flow.summary)}</p>`,
              filesHtml,
              stepsHtml,
              `</article>`,
            ].join('\n');
          })
          .join('\n')
      : '<p class="empty-state">No execution flows synthesized yet.</p>';

  const conventionsHtml =
    conventions.length > 0
      ? `<div class="conventions-box"><h3>Engineering Conventions &amp; Invariants</h3><ul>${conventions
          .map((c) => `<li>${escapeHtml(c)}</li>`)
          .join('')}</ul></div>`
      : '';

  const lessonsHtml =
    lessons.length > 0
      ? lessons
          .map((lesson) => {
            const promptText = lesson.userPrompt?.content ?? '';
            const assistantText = lesson.assistantMessage?.content ?? '';
            const visuals = lesson.assistantMessage?.visuals ?? [];
            const checkIns = lesson.assistantMessage?.checkInQuestions ?? [];
            const nextSteps = lesson.assistantMessage?.suggestedNextSteps ?? [];
            const filterText = `${lesson.title} ${lesson.stageLabel} ${promptText} ${assistantText} ${visuals
              .map((v) => `${v.title} ${v.caption ?? ''}`)
              .join(' ')}`.toLowerCase();

            const promptHtml = lesson.userPrompt
              ? [
                  `<div class="user-prompt-card">`,
                  `  <div class="prompt-label">Developer Question / Exploration Prompt</div>`,
                  `  <div class="prompt-body">${renderMarkdownToHtml(lesson.userPrompt.content)}</div>`,
                  `</div>`,
                ].join('\n')
              : '';

            const assistantHtml = lesson.assistantMessage
              ? `<div class="lesson-prose">${renderMarkdownToHtml(lesson.assistantMessage.content)}</div>`
              : '';

            const visualsHtml =
              visuals.length > 0
                ? `<div class="lesson-visuals">${visuals.map((v) => renderVisualHtml(v)).join('\n')}</div>`
                : '';

            const checkInHtml = renderCheckInHtml(checkIns);
            const nextStepsHtml = renderSuggestedStepsHtml(nextSteps);

            return [
              `<article id="${lesson.id}" class="lesson-card" data-filterable="lesson" data-lesson-id="${lesson.id}" data-filter-text="${escapeHtml(filterText)}">`,
              `  <header class="lesson-header">`,
              `    <div class="lesson-header-meta">`,
              `      <span class="lesson-num-badge">Lesson ${lesson.index}</span>`,
              `      <span class="stage-pill">${escapeHtml(lesson.stageLabel)}</span>`,
              `      <time class="lesson-time" datetime="${escapeHtml(lesson.createdAt)}">${escapeHtml(lesson.createdAt)}</time>`,
              `    </div>`,
              `    <h3 class="lesson-title">${escapeHtml(lesson.title)}</h3>`,
              `  </header>`,
              promptHtml,
              assistantHtml,
              visualsHtml,
              checkInHtml,
              nextStepsHtml,
              `</article>`,
            ].join('\n');
          })
          .join('\n')
      : '<p class="empty-state">No interactive whiteboard lessons recorded yet in this session.</p>';

  const observedFilesHtml =
    observedFilesList.length > 0
      ? `<div class="observed-files-strip"><span class="meta-label">Observed Files (${observedFilesCount}):</span> ${observedFilesList
          .slice(0, 24)
          .map((f) => `<code class="file-pill">${escapeHtml(f)}</code>`)
          .join(' ')}</div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(repoName)} — Scavenger Onboarding Handbook</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js" defer></script>
  <style>
    :root, [data-theme="dark"] {
      --bg: #0b101b;
      --bg-elevated: #121a2b;
      --bg-card: #162033;
      --bg-muted: #1d2a42;
      --text: #e6edf7;
      --text-secondary: #9fb0cb;
      --text-muted: #6e82a3;
      --border: #263654;
      --accent: #38bdf8;
      --accent-soft: rgba(56, 189, 248, 0.14);
      --emerald: #34d399;
      --amber: #fbbf24;
      --violet: #a78bfa;
      --highlight-bg: rgba(250, 204, 21, 0.24);
      --highlight-border: rgba(250, 204, 21, 0.55);
      --highlight-text: #fef08a;
      --code-bg: #0d1524;
      --shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }

    [data-theme="light"] {
      --bg: #f8fafc;
      --bg-elevated: #ffffff;
      --bg-card: #ffffff;
      --bg-muted: #f1f5f9;
      --text: #0f172a;
      --text-secondary: #334155;
      --text-muted: #64748b;
      --border: #dbe3ef;
      --accent: #0284c7;
      --accent-soft: rgba(2, 132, 199, 0.1);
      --emerald: #059669;
      --amber: #d97706;
      --violet: #7c3aed;
      --highlight-bg: #fef08a;
      --highlight-border: #eab308;
      --highlight-text: #713f12;
      --code-bg: #f1f5f9;
      --shadow: 0 6px 20px rgba(15, 23, 42, 0.06);
    }

    * {
      box-sizing: border-box;
    }

    html {
      scroll-behavior: smooth;
    }

    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.65;
    }

    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.9em;
    }

    .handbook-topbar {
      position: sticky;
      top: 0;
      z-index: 40;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.85rem 1.5rem;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border);
      box-shadow: var(--shadow);
    }

    .topbar-brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .brand-pill {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 0.25rem 0.6rem;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      border: 1px solid var(--accent);
    }

    .topbar-title {
      margin: 0;
      font-size: 1.1rem;
      font-weight: 700;
    }

    .topbar-meta {
      font-size: 0.82rem;
      color: var(--text-secondary);
    }

    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }

    .btn-action {
      cursor: pointer;
      padding: 0.42rem 0.85rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
      background: var(--bg-muted);
      color: var(--text);
      font-size: 0.82rem;
      font-weight: 600;
      transition: border-color 0.15s ease, background 0.15s ease;
    }

    .btn-action:hover {
      border-color: var(--accent);
    }

    .handbook-layout {
      display: grid;
      grid-template-columns: 290px minmax(0, 1fr);
      max-width: 1440px;
      margin: 0 auto;
      gap: 2rem;
      padding: 1.75rem 1.5rem 4rem;
    }

    .handbook-sidebar {
      position: sticky;
      top: 4.5rem;
      align-self: start;
      max-height: calc(100vh - 5.5rem);
      overflow-y: auto;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 0.85rem;
      padding: 1rem;
    }

    .filter-box {
      margin-bottom: 1rem;
    }

    .filter-label {
      display: block;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-secondary);
      margin-bottom: 0.4rem;
    }

    .filter-input {
      width: 100%;
      padding: 0.5rem 0.65rem;
      border-radius: 0.45rem;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 0.85rem;
    }

    .filter-input:focus {
      outline: 2px solid var(--accent);
      border-color: transparent;
    }

    .filter-status {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 0.35rem;
    }

    .toc-nav {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .toc-heading {
      font-size: 0.74rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      margin: 0.5rem 0 0.25rem;
    }

    .toc-link, .toc-sublink {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      text-decoration: none;
      color: var(--text-secondary);
      padding: 0.38rem 0.55rem;
      border-radius: 0.4rem;
      font-size: 0.86rem;
      transition: background 0.12s ease, color 0.12s ease;
    }

    .toc-link:hover, .toc-sublink:hover {
      background: var(--bg-muted);
      color: var(--accent);
    }

    .toc-sublink {
      padding-left: 1rem;
      font-size: 0.8rem;
    }

    .toc-lesson-num {
      font-family: ui-monospace, monospace;
      font-size: 0.73rem;
      color: var(--accent);
      flex-shrink: 0;
    }

    .handbook-main {
      display: flex;
      flex-direction: column;
      gap: 2.25rem;
      min-width: 0;
    }

    .handbook-section {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 0.95rem;
      padding: 1.6rem 1.85rem;
      box-shadow: var(--shadow);
    }

    .section-title {
      margin: 0 0 1rem;
      font-size: 1.35rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.65rem;
    }

    .summary-kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 0.85rem;
      margin-bottom: 1.25rem;
    }

    .kpi-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 0.65rem;
      padding: 0.8rem 1rem;
    }

    .kpi-label {
      font-size: 0.74rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    .kpi-value {
      font-size: 1.05rem;
      font-weight: 700;
      margin-top: 0.25rem;
      word-break: break-word;
    }

    .stack-chip, .file-pill, .dep-chip, .symbol-chip, .kind-pill, .stage-pill, .focus-chip {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 0.35rem;
      background: var(--bg-muted);
      border: 1px solid var(--border);
      font-size: 0.78rem;
      margin: 0.1rem;
    }

    .mastery-badge {
      display: inline-block;
      padding: 0.2rem 0.55rem;
      border-radius: 999px;
      font-size: 0.76rem;
      font-weight: 700;
      text-transform: uppercase;
    }

    .mastery-solid {
      background: rgba(52, 211, 153, 0.18);
      color: var(--emerald);
      border: 1px solid var(--emerald);
    }

    .mastery-developing {
      background: rgba(56, 189, 248, 0.18);
      color: var(--accent);
      border: 1px solid var(--accent);
    }

    .mastery-introduced {
      background: rgba(251, 191, 36, 0.18);
      color: var(--amber);
      border: 1px solid var(--amber);
    }

    .mastery-unexplored {
      background: var(--bg-muted);
      color: var(--text-muted);
      border: 1px solid var(--border);
    }

    .progress-bar-outer {
      width: 100%;
      height: 0.65rem;
      background: var(--bg-muted);
      border-radius: 999px;
      overflow: hidden;
      margin: 0.5rem 0 1.2rem;
    }

    .progress-bar-inner {
      height: 100%;
      background: linear-gradient(90deg, var(--accent), var(--emerald));
    }

    .table-wrap {
      overflow-x: auto;
    }

    .data-table, .prose-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }

    .data-table th, .data-table td, .prose-table th, .prose-table td {
      text-align: left;
      padding: 0.65rem 0.75rem;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }

    .data-table th, .prose-table th {
      font-size: 0.76rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
      background: var(--bg-muted);
    }

    .modules-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1rem;
    }

    .module-card, .flow-card, .lesson-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.15rem 1.25rem;
    }

    .module-card-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .layer-badge {
      display: inline-block;
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 0.15rem 0.45rem;
      border-radius: 0.3rem;
      background: var(--accent-soft);
      color: var(--accent);
    }

    .module-id {
      margin: 0.3rem 0;
      font-size: 1.05rem;
    }

    .module-role {
      color: var(--text-secondary);
      font-size: 0.9rem;
      margin: 0.4rem 0 0.75rem;
    }

    .module-meta-grid {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      font-size: 0.83rem;
    }

    .meta-label {
      font-weight: 600;
      color: var(--text-secondary);
    }

    .flows-stack, .lessons-stack {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .flow-arrow {
      margin: 0 0.35rem;
      color: var(--accent);
    }

    .lesson-header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.75rem;
      margin-bottom: 1rem;
    }

    .lesson-header-meta {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      flex-wrap: wrap;
      font-size: 0.8rem;
      color: var(--text-secondary);
    }

    .lesson-num-badge {
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 700;
      padding: 0.15rem 0.55rem;
      border-radius: 999px;
    }

    .lesson-title {
      margin: 0.45rem 0 0;
      font-size: 1.2rem;
    }

    .user-prompt-card {
      background: var(--bg-muted);
      border-left: 4px solid var(--accent);
      padding: 0.75rem 1rem;
      border-radius: 0.45rem;
      margin-bottom: 1rem;
    }

    .prompt-label {
      font-size: 0.74rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--accent);
      margin-bottom: 0.25rem;
    }

    .scavenger-highlight {
      background: var(--highlight-bg);
      color: var(--highlight-text);
      border-bottom: 2px solid var(--highlight-border);
      padding: 0.08rem 0.32rem;
      border-radius: 0.25rem;
      font-weight: 600;
    }

    .code-block {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 0.55rem;
      padding: 0.9rem 1rem;
      overflow-x: auto;
    }

    .visual-card {
      margin: 1.1rem 0;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 0.7rem;
      padding: 1rem 1.15rem;
    }

    .visual-card-header {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin-bottom: 0.75rem;
    }

    .visual-badge {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      padding: 0.18rem 0.5rem;
      border-radius: 0.3rem;
      background: var(--accent-soft);
      color: var(--accent);
    }

    .visual-title {
      margin: 0;
      font-size: 1rem;
    }

    .mermaid-viewport, .visual-svg-container, .visual-image-wrap {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 0.85rem;
      overflow-x: auto;
    }

    .visual-image-wrap img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
      border-radius: 0.4rem;
    }

    .visual-caption {
      font-size: 0.83rem;
      color: var(--text-secondary);
      margin-top: 0.55rem;
      font-style: italic;
    }

    .diagram-source-details {
      margin-top: 0.65rem;
      font-size: 0.82rem;
    }

    .diagram-source-details summary {
      cursor: pointer;
      color: var(--text-secondary);
      font-weight: 600;
    }

    .concept-elements-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 0.65rem;
      margin-top: 0.65rem;
    }

    .concept-element-item {
      background: var(--bg-muted);
      border: 1px solid var(--border);
      border-radius: 0.45rem;
      padding: 0.55rem 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      font-size: 0.84rem;
    }

    .lesson-callout {
      margin-top: 1rem;
      background: var(--bg-muted);
      border: 1px solid var(--border);
      border-radius: 0.6rem;
      padding: 0.85rem 1rem;
    }

    .callout-header {
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--accent);
      margin-bottom: 0.5rem;
    }

    .next-steps-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 0.75rem;
    }

    .next-step-item {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 0.7rem 0.85rem;
    }

    .is-hidden-by-filter {
      display: none !important;
    }

    @media (max-width: 960px) {
      .handbook-layout {
        grid-template-columns: 1fr;
      }
      .handbook-sidebar {
        position: static;
        max-height: none;
      }
    }

    @media print {
      :root, [data-theme="dark"], [data-theme="light"] {
        --bg: #ffffff;
        --bg-elevated: #ffffff;
        --bg-card: #ffffff;
        --bg-muted: #f8fafc;
        --text: #0f172a;
        --text-secondary: #334155;
        --text-muted: #64748b;
        --border: #cbd5e1;
        --highlight-bg: #fef08a;
        --highlight-text: #000000;
        --shadow: none;
      }
      .handbook-topbar .topbar-actions,
      .handbook-sidebar {
        display: none !important;
      }
      .handbook-layout {
        display: block;
        padding: 0;
      }
      .handbook-section, .lesson-card, .module-card, .flow-card {
        break-inside: avoid;
        box-shadow: none;
        margin-bottom: 1.25rem;
      }
    }
  </style>
</head>
<body>
  <header class="handbook-topbar">
    <div class="topbar-brand">
      <span class="brand-pill">Scavenger Handbook</span>
      <h1 class="topbar-title">${escapeHtml(repoName)}</h1>
      <span class="topbar-meta"><code>${escapeHtml(branch)}</code> @ <code>${escapeHtml(headCommit)}</code> · Mastery ${overallMasteryPercent}%</span>
    </div>
    <div class="topbar-actions">
      <button type="button" id="theme-toggle" class="btn-action" aria-label="Toggle Light or Dark Mode">Toggle Light / Dark</button>
      <button type="button" id="print-handbook" class="btn-action" onclick="window.print()">Print / Save PDF</button>
    </div>
  </header>

  <div class="handbook-layout">
    <aside class="handbook-sidebar" aria-label="Handbook Table of Contents">
      <div class="filter-box">
        <label class="filter-label" for="handbook-filter">Filter Handbook</label>
        <input
          id="handbook-filter"
          class="filter-input"
          type="search"
          placeholder="Filter modules, flows &amp; lessons..."
          autocomplete="off"
        />
        <div id="handbook-filter-status" class="filter-status">Showing all sections</div>
      </div>
      <nav class="toc-nav">
        <div class="toc-heading">Sections</div>
        <a class="toc-link" href="#overview">Executive Summary</a>
        <a class="toc-link" href="#mastery">Mastery &amp; Topics (${overallMasteryPercent}%)</a>
        <a class="toc-link" href="#modules">Architecture Modules (${modules.length})</a>
        <a class="toc-link" href="#flows">Entry Points &amp; Flows (${coreFlows.length})</a>
        <a class="toc-link" href="#lessons">Whiteboard Lessons (${lessons.length})</a>
        <div class="toc-heading">Lessons</div>
        ${tocLessonsHtml}
      </nav>
    </aside>

    <main class="handbook-main">
      <section id="overview" class="handbook-section">
        <h2 class="section-title">Executive Summary &amp; Repository Overview</h2>
        <div class="summary-kpi-grid">
          <div class="kpi-card">
            <div class="kpi-label">Repository</div>
            <div class="kpi-value">${escapeHtml(repoName)}</div>
            <div class="topbar-meta"><code>${escapeHtml(session.repoPath)}</code></div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Git Branch &amp; HEAD</div>
            <div class="kpi-value"><code>${escapeHtml(branch)}</code></div>
            <div class="topbar-meta">Commit: <code>${escapeHtml(headCommit)}</code></div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Explanation Depth</div>
            <div class="kpi-value">${escapeHtml(inferredLevel)}</div>
            <div class="topbar-meta">${escapeHtml(session.diagnostic?.goal || 'Interactive architectural onboarding')}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Observed Evidence</div>
            <div class="kpi-value">${observedFilesCount} files · ${observedCommitsCount} commits</div>
            <div class="topbar-meta">Exported ${escapeHtml(generatedAt)}</div>
          </div>
        </div>

        <div>
          <span class="meta-label">Detected Stack:</span> ${stackChipsHtml}
        </div>

        <h3>Repository Purpose</h3>
        <div class="overview-prose">${renderMarkdownToHtml(purpose)}</div>

        <h3>Architecture Overview</h3>
        <div class="overview-prose">${renderMarkdownToHtml(architectureOverview)}</div>

        ${observedFilesHtml}
      </section>

      <section id="mastery" class="handbook-section">
        <h2 class="section-title">Mastery &amp; Topics Progress (${overallMasteryPercent}%)</h2>
        <p class="topbar-meta">${solidCount} solid · ${exploredCount} explored out of ${topics.length} total onboarding topics</p>
        <div class="progress-bar-outer" role="progressbar" aria-valuenow="${overallMasteryPercent}" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-bar-inner" style="width: ${overallMasteryPercent}%"></div>
        </div>
        ${
          session.learning?.lastAssessmentSummary
            ? `<p><strong>Latest Assessment:</strong> ${escapeHtml(session.learning.lastAssessmentSummary)}</p>`
            : ''
        }
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Topic</th>
                <th>Kind</th>
                <th>Mastery</th>
                <th>Related Files</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              ${topicsRowsHtml}
            </tbody>
          </table>
        </div>
      </section>

      <section id="modules" class="handbook-section">
        <h2 class="section-title">Architecture Module Directory (${modules.length})</h2>
        <div class="modules-grid">
          ${modulesCardsHtml}
        </div>
      </section>

      <section id="flows" class="handbook-section">
        <h2 class="section-title">Entry Points &amp; Core Execution Flows</h2>
        <h3>Entry Points</h3>
        ${entryPointsHtml}

        <h3>Core Execution Flows</h3>
        <div class="flows-stack">
          ${coreFlowsHtml}
        </div>

        ${conventionsHtml}
      </section>

      <section id="lessons" class="handbook-section">
        <h2 class="section-title">Curated Whiteboard Lessons &amp; Walkthroughs (${lessons.length})</h2>
        <div class="lessons-stack">
          ${lessonsHtml}
        </div>
      </section>
    </main>
  </div>

  <script>
    (function () {
      var htmlEl = document.documentElement;
      var themeBtn = document.getElementById('theme-toggle');
      if (themeBtn) {
        themeBtn.addEventListener('click', function () {
          var current = htmlEl.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
          var next = current === 'dark' ? 'light' : 'dark';
          htmlEl.setAttribute('data-theme', next);
        });
      }

      var filterInput = document.getElementById('handbook-filter');
      var filterStatus = document.getElementById('handbook-filter-status');
      if (filterInput) {
        filterInput.addEventListener('input', function () {
          var query = (filterInput.value || '').trim().toLowerCase();
          var items = document.querySelectorAll('[data-filterable]');
          var visibleCount = 0;
          for (var i = 0; i < items.length; i++) {
            var el = items[i];
            var haystack = (el.getAttribute('data-filter-text') || '').toLowerCase();
            var match = !query || haystack.indexOf(query) !== -1;
            el.classList.toggle('is-hidden-by-filter', !match);
            if (match) visibleCount++;
          }

          var tocLinks = document.querySelectorAll('[data-toc-lesson]');
          for (var j = 0; j < tocLinks.length; j++) {
            var link = tocLinks[j];
            var linkText = (link.getAttribute('data-filter-text') || '').toLowerCase();
            var linkMatch = !query || linkText.indexOf(query) !== -1;
            link.classList.toggle('is-hidden-by-filter', !linkMatch);
          }

          if (filterStatus) {
            filterStatus.textContent = query
              ? 'Matching items: ' + visibleCount + ' for "' + query + '"'
              : 'Showing all sections';
          }
        });
      }

      window.addEventListener('DOMContentLoaded', function () {
        if (window.mermaid && typeof window.mermaid.initialize === 'function') {
          window.mermaid.initialize({ startOnLoad: true, securityLevel: 'strict' });
        }
      });
    })();
  </script>
</body>
</html>
`;
}

/**
 * Compiles an onboarding session into a portable Onboarding Handbook in either
 * self-contained interactive HTML ('html') or GitHub-Flavored Markdown ('md').
 */
export function generateSessionHandbook(
  session: InternalSession,
  format: HandbookExportFormat = 'html'
): HandbookExportResponse {
  const normalizedFormat: HandbookExportFormat = format === 'md' ? 'md' : 'html';
  const generatedAt = new Date().toISOString();
  const slug = slugifyRepoName(session.repoName);
  const filename = `${slug}-onboarding-handbook.${normalizedFormat}`;
  const mimeType =
    normalizedFormat === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8';
  const content =
    normalizedFormat === 'md'
      ? generateMarkdownHandbook(session, generatedAt)
      : generateHtmlHandbook(session, generatedAt);

  return {
    format: normalizedFormat,
    filename,
    mimeType,
    content,
    generatedAt,
  };
}
