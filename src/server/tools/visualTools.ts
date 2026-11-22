import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import type {
  ConceptVisualAccent,
  ConceptVisualElement,
  ConceptVisualLayout,
  VisualArtifact,
} from '../../shared/types.js';
import { getEffectiveVisualSettings } from '../settingsStore.js';

let cachedD2Available: boolean | null = null;

export async function checkD2Available(): Promise<boolean> {
  if (cachedD2Available !== null) return cachedD2Available;
  cachedD2Available = await new Promise<boolean>((resolve) => {
    execFile('d2', ['--version'], { shell: false, timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
  return cachedD2Available;
}

export interface D2RenderResult {
  ok: boolean;
  svg?: string;
  error?: string;
}

function execD2(args: string[], source: string): Promise<D2RenderResult> {
  return new Promise<D2RenderResult>((resolve) => {
    const child = execFile(
      'd2',
      args,
      { shell: false, timeout: 8000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            error: (stderr || err.message || 'Failed to render D2 diagram.').trim().slice(0, 300),
          });
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed.startsWith('<svg')) {
          resolve({ ok: false, error: 'D2 returned unexpected output instead of SVG.' });
          return;
        }
        resolve({ ok: true, svg: trimmed });
      }
    );

    child.stdin?.write(source);
    child.stdin?.end();
  });
}

/**
 * Compiles D2 diagram source to SVG using local `d2` CLI via stdin -> stdout (zero disk writes).
 * Applies refined neutral styling (`--theme=1 --pad=28`) with graceful fallback to default flags.
 */
export async function renderD2ToSvg(
  source: string,
  options?: { sketch?: boolean }
): Promise<D2RenderResult> {
  const available = await checkD2Available();
  if (!available) {
    return {
      ok: false,
      error: 'Local D2 CLI is not installed on PATH. Install via `brew install d2` or use Mermaid.',
    };
  }

  const styledArgs = ['--theme=1', '--pad=28', ...(options?.sketch ? ['--sketch'] : []), '-', '-'];
  const styled = await execD2(styledArgs, source);
  if (styled.ok) {
    return styled;
  }

  // Fallback for older D2 binaries that may reject styling flags
  return execD2(['-', '-'], source);
}

export interface ConceptVisualInput {
  title: string;
  metaphor: string;
  caption?: string;
  prompt?: string;
  layout?: ConceptVisualLayout;
  accent?: ConceptVisualAccent;
  elements?: ConceptVisualElement[];
}

function buildEditorialImagePrompt(input: ConceptVisualInput, layout: ConceptVisualLayout): string {
  if (input.prompt?.trim()) {
    return input.prompt.trim();
  }

  const compositionHint =
    layout === 'layers'
      ? 'Clean isometric stacked architectural strata floating with gentle elevation and subtle vertical light-beam connections.'
      : layout === 'hub'
        ? 'Refined isometric central architectural core surrounded by balanced orbiting modular stations connected by luminous clean pathways.'
        : 'Sleek left-to-right architectural flow of interconnected modular glass-and-ceramic stations guiding energy smoothly across stages.';

  const elementsBrief =
    input.elements && input.elements.length > 0
      ? ` Key visual components represented symbolically (as clean sculptural objects, never text): ${input.elements
          .slice(0, 4)
          .map((e) => `${e.label} (${e.role})`)
          .join('; ')}.`
      : '';

  return [
    `High-craft editorial technical illustration visualizing the architectural metaphor: "${input.title}".`,
    `Core concept: ${input.metaphor}`,
    compositionHint + elementsBrief,
    `Visual style: modern Stripe Press / Linear editorial vector & soft-3D architectural aesthetic, soft warm alabaster background (#F8FAFC), crisp deep slate geometry (#1E293B), harmonized cobalt blue (#2563EB), emerald teal (#0D9488), and subtle warm amber (#D97706) highlights, soft studio shadows, generous whitespace, calm visual hierarchy.`,
    `CRITICAL CONSTRAINT: strictly NO text, NO letters, NO words, NO numbers, NO watermarks, and NO UI screenshots anywhere inside the artwork.`,
  ].join(' ');
}

/**
 * Generates an optional metaphor/concept visual via Gemini Imagen or OpenAI Images when configured,
 * falling back cleanly to a bespoke editorial multi-layout inline SVG concept illustration.
 */
export async function generateConceptVisual(input: ConceptVisualInput): Promise<VisualArtifact> {
  const id = `vis_${crypto.randomUUID().slice(0, 8)}`;
  const layout = inferConceptLayout(input);
  const accent = inferConceptAccent(input);
  const elements = normalizeElements(input.elements);
  const visualConfig = getEffectiveVisualSettings();
  const { imageGenEnabled, geminiApiKey: geminiKey, openaiApiKey: openaiKey } = visualConfig;

  const visualPrompt = buildEditorialImagePrompt({ ...input, elements }, layout);

  if (imageGenEnabled && geminiKey) {
    try {
      const model = visualConfig.geminiImageModel;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:predict?key=${encodeURIComponent(geminiKey)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt: visualPrompt }],
          parameters: { sampleCount: 1, aspectRatio: '16:9' },
        }),
        signal: AbortSignal.timeout(20_000),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
        };
        const first = data.predictions?.[0];
        if (first?.bytesBase64Encoded) {
          const mime = first.mimeType || 'image/png';
          return {
            id,
            kind: 'concept-image',
            title: input.title,
            caption: input.caption ?? input.metaphor,
            metaphor: input.metaphor,
            layout,
            accent,
            elements,
            imageDataUrl: `data:${mime};base64,${first.bytesBase64Encoded}`,
            isFallback: false,
          };
        }
      }
    } catch {
      // Fall through to OpenAI or clean SVG fallback
    }
  }

  if (imageGenEnabled && openaiKey) {
    try {
      const model = visualConfig.openaiImageModel;
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model,
          prompt: visualPrompt,
          size: '1536x1024',
          n: 1,
        }),
        signal: AbortSignal.timeout(25_000),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          data?: Array<{ b64_json?: string; url?: string }>;
        };
        const first = data.data?.[0];
        if (first?.b64_json) {
          return {
            id,
            kind: 'concept-image',
            title: input.title,
            caption: input.caption ?? input.metaphor,
            metaphor: input.metaphor,
            layout,
            accent,
            elements,
            imageDataUrl: `data:image/png;base64,${first.b64_json}`,
            isFallback: false,
          };
        }
        if (first?.url) {
          return {
            id,
            kind: 'concept-image',
            title: input.title,
            caption: input.caption ?? input.metaphor,
            metaphor: input.metaphor,
            layout,
            accent,
            elements,
            imageDataUrl: first.url,
            isFallback: false,
          };
        }
      }
    } catch {
      // Fall through to clean SVG fallback
    }
  }

  const fallbackReason = !imageGenEnabled
    ? 'Image generation disabled; rendered editorial vector concept map.'
    : 'Rendered editorial vector concept map (no raster image API configured or reachable).';

  return {
    id,
    kind: 'concept-image',
    title: input.title,
    caption: input.caption ?? input.metaphor,
    metaphor: input.metaphor,
    layout,
    accent,
    elements,
    svgMarkup: buildFallbackConceptSvg({ ...input, layout, accent, elements }),
    isFallback: true,
    fallbackReason,
  };
}

interface PaletteSpec {
  primary: string;
  primarySoft: string;
  primaryBorder: string;
  secondaryGlow: string;
  badgeText: string;
}

const ACCENT_PALETTES: Record<ConceptVisualAccent, PaletteSpec> = {
  cobalt: {
    primary: '#2563EB',
    primarySoft: '#EFF6FF',
    primaryBorder: '#BFDBFE',
    secondaryGlow: '#DBEAFE',
    badgeText: '#1D4ED8',
  },
  emerald: {
    primary: '#0D9488',
    primarySoft: '#F0FDFA',
    primaryBorder: '#99F6E4',
    secondaryGlow: '#CCFBF1',
    badgeText: '#0F766E',
  },
  violet: {
    primary: '#6366F1',
    primarySoft: '#EEF2FF',
    primaryBorder: '#C7D2FE',
    secondaryGlow: '#E0E7FF',
    badgeText: '#4338CA',
  },
  amber: {
    primary: '#D97706',
    primarySoft: '#FFFBEB',
    primaryBorder: '#FDE68A',
    secondaryGlow: '#FEF3C7',
    badgeText: '#B45309',
  },
};

const NODE_TONES = [
  { stroke: '#2563EB', soft: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8', bar: '#3B82F6' },
  { stroke: '#6366F1', soft: '#EEF2FF', border: '#C7D2FE', text: '#4338CA', bar: '#6366F1' },
  { stroke: '#0D9488', soft: '#F0FDFA', border: '#99F6E4', text: '#0F766E', bar: '#14B8A6' },
  { stroke: '#D97706', soft: '#FFFBEB', border: '#FDE68A', text: '#B45309', bar: '#F59E0B' },
] as const;

const LAYOUT_BADGE_LABELS: Record<ConceptVisualLayout, string> = {
  pipeline: 'MENTAL MODEL · FLOW',
  hub: 'MENTAL MODEL · SYSTEM HUB',
  layers: 'MENTAL MODEL · LAYERS',
};

function inferConceptLayout(input: ConceptVisualInput): ConceptVisualLayout {
  if (input.layout) return input.layout;
  const text = `${input.title} ${input.metaphor}`.toLowerCase();
  if (/\b(layer|layers|layered|stack|strata|foundation|boundary|boundaries|root|workshop)\b/.test(text)) {
    return 'layers';
  }
  if (/\b(hub|center|central|orchestrat|coordinator|core|satellite|spoke|router)\b/.test(text)) {
    return 'hub';
  }
  return 'pipeline';
}

function inferConceptAccent(input: ConceptVisualInput): ConceptVisualAccent {
  if (input.accent) return input.accent;
  const text = `${input.title} ${input.metaphor}`.toLowerCase();
  if (/\b(guard|safe|security|read-only|shield|validat|check|relay)\b/.test(text)) {
    return 'emerald';
  }
  if (/\b(history|git|evolution|timeline|churn|commit|milestone)\b/.test(text)) {
    return 'amber';
  }
  if (/\b(architect|orchestrat|graph|hub|agent|model|stream)\b/.test(text)) {
    return 'violet';
  }
  return 'cobalt';
}

function normalizeElements(elements?: ConceptVisualElement[]): ConceptVisualElement[] {
  if (elements && elements.length > 0) {
    return elements.slice(0, 4);
  }
  return [
    { label: 'Input Boundary', role: 'Validates incoming triggers & contracts' },
    { label: 'Core Engine', role: 'Executes focused domain logic & state' },
    { label: 'Output Layer', role: 'Delivers predictable artifacts & responses' },
  ];
}

function selectGlyphPaths(label: string, role: string, index: number): string {
  const text = `${label} ${role}`.toLowerCase();
  if (/\b(guard|shield|lock|safe|gate|validat|security|boundary|rule|check)\b/.test(text)) {
    // Shield check
    return `<path d="M12 3l7 3v5c0 4.5-3 7.8-7 9.5C8 18.8 5 15.5 5 11V6l7-3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.2 11.6l2 2 3.8-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (/\b(git|commit|branch|history|evolution|version)\b/.test(text)) {
    // Git branch
    return `<circle cx="7" cy="6" r="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="7" cy="18" r="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17" cy="9" r="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 8.2v7.6M17 11.2c0 3.2-2.6 4.6-7.8 4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
  }
  if (/\b(ui|chat|view|client|surface|visual|output|response|caller|contract)\b/.test(text)) {
    // Window / surface
    return `<rect x="3.5" y="4.5" width="17" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 9h17" stroke="currentColor" stroke-width="1.6"/><circle cx="6.8" cy="6.8" r="0.8" fill="currentColor"/><circle cx="9.6" cy="6.8" r="0.8" fill="currentColor"/>`;
  }
  if (/\b(config|manifest|root|build|dep|package|spec|schema)\b/.test(text)) {
    // Stacked layers / config
    return `<path d="M12 4l8 4-8 4-8-4 8-4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (/\b(store|state|data|db|cache|memory|session)\b/.test(text)) {
    // Database cylinder
    return `<ellipse cx="12" cy="6.5" rx="7" ry="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 6.5v10.5c0 1.5 3.1 2.6 7 2.6s7-1.1 7-2.6V6.5M5 11.8c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>`;
  }
  if (/\b(engine|core|orchestrat|logic|runtime|transform|src|process|tool)\b/.test(text)) {
    // CPU / core chip
    return `<rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="9.8" y="9.8" width="4.4" height="4.4" rx="1" fill="currentColor"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`;
  }
  // Fallback rotating icons by position
  if (index % 3 === 0) {
    return `<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4l2.8 1.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
  }
  if (index % 3 === 1) {
    return `<path d="M12 4l8 4-8 4-8-4 8-4zM4 12l8 4 8-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return `<path d="M5 12h12M13 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function renderIconBadge(
  x: number,
  y: number,
  size: number,
  tone: (typeof NODE_TONES)[number],
  label: string,
  role: string,
  index: number
): string {
  const scale = (size * 0.56) / 24;
  const offset = (size - 24 * scale) / 2;
  const glyph = selectGlyphPaths(label, role, index);
  return `
    <g transform="translate(${x}, ${y})">
      <rect width="${size}" height="${size}" rx="9" fill="${tone.soft}" stroke="${tone.border}" stroke-width="1.2" />
      <g transform="translate(${offset.toFixed(1)}, ${offset.toFixed(1)}) scale(${scale.toFixed(3)})" color="${tone.stroke}">
        ${glyph}
      </g>
    </g>
  `;
}

/**
 * Word-wraps text cleanly on word boundaries without slicing words mid-character.
 */
export function wrapSvgText(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];

  const words = cleaned.split(' ');
  const lines: string[] = [];
  let current = '';

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const candidate = current ? `${current} ${word}` : word;

    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      if (lines.length === maxLines) {
        lines[maxLines - 1] = appendEllipsis(lines[maxLines - 1], maxCharsPerLine);
        return lines;
      }
      current = word.length > maxCharsPerLine ? truncate(word, maxCharsPerLine) : word;
    } else {
      current = truncate(word, maxCharsPerLine);
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.slice(0, maxLines);
}

function appendEllipsis(line: string, maxChars: number): string {
  const base = line.replace(/[.,;:\s]+$/, '');
  if (base.length + 1 <= maxChars) return `${base}…`;
  return `${base.slice(0, Math.max(1, maxChars - 1))}…`;
}

function renderTextLines(
  lines: string[],
  x: number,
  startY: number,
  lineHeight: number,
  attrs: string
): string {
  return lines
    .map(
      (line, idx) =>
        `<text x="${x}" y="${startY + idx * lineHeight}" ${attrs}>${escapeXml(line)}</text>`
    )
    .join('\n');
}

/**
 * Editorial multi-layout SVG concept illustration composer used whenever raster image generation
 * is unavailable, disabled, or fails. Uses unique per-SVG `<defs>` IDs to avoid DOM collisions.
 */
export function buildFallbackConceptSvg(input: ConceptVisualInput): string {
  const uid = crypto.randomBytes(4).toString('hex');
  const layout = inferConceptLayout(input);
  const accentKey = inferConceptAccent(input);
  const palette = ACCENT_PALETTES[accentKey];
  const nodes = normalizeElements(input.elements);

  const width = 800;
  const padX = 34;

  const titleLines = wrapSvgText(input.title, 54, 2);
  const metaphorLines = wrapSvgText(input.metaphor, 84, 2);

  const badgeY = 26;
  const titleY = badgeY + 46;
  const metaphorY = titleY + (titleLines.length - 1) * 26 + 22;
  const bodyTop = metaphorY + (Math.max(1, metaphorLines.length) - 1) * 19 + 28;

  let bodyMarkup = '';
  let totalHeight = bodyTop + 180;

  if (layout === 'layers') {
    const layerH = 74;
    const layerGap = 16;
    const baseW = width - padX * 2;
    const stepIndent = nodes.length > 1 ? 14 : 0;

    const layersMarkup = nodes
      .map((node, index) => {
        const tone = NODE_TONES[index % NODE_TONES.length];
        const indent = index * stepIndent;
        const x = padX + indent;
        const w = baseW - indent * 2;
        const y = bodyTop + index * (layerH + layerGap);

        const labelLines = wrapSvgText(node.label, 34, 1);
        const roleLines = wrapSvgText(node.role, Math.max(36, Math.floor((w - 190) / 6.8)), 2);
        const roleStartY = roleLines.length > 1 ? y + 32 : y + 41;

        const connector =
          index < nodes.length - 1
            ? `<g>
                <line x1="${width / 2}" y1="${y + layerH + 1}" x2="${width / 2}" y2="${y + layerH + layerGap - 3}" stroke="${palette.primary}" stroke-opacity="0.55" stroke-width="1.8" marker-end="url(#arrow-${uid})" />
              </g>`
            : '';

        return `
          <g filter="url(#shadow-${uid})">
            <rect x="${x}" y="${y}" width="${w}" height="${layerH}" rx="15" fill="#FFFFFF" stroke="${tone.border}" stroke-width="1.35" />
            <rect x="${x}" y="${y + 14}" width="4.5" height="${layerH - 28}" rx="2.25" fill="${tone.bar}" />
            ${renderIconBadge(x + 18, y + 19, 36, tone, node.label, node.role, index)}
            <text x="${x + 68}" y="${y + 32}" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="600" letter-spacing="0.06em" fill="${tone.text}">LAYER 0${index + 1}</text>
            ${renderTextLines(labelLines, x + 68, y + 53, 18, 'font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="14.5" font-weight="600" fill="#0F172A"')}
            <line x1="${x + Math.min(285, Math.floor(w * 0.42))}" y1="${y + 18}" x2="${x + Math.min(285, Math.floor(w * 0.42))}" y2="${y + layerH - 18}" stroke="#E2E8F0" stroke-width="1" />
            ${renderTextLines(
              roleLines,
              x + Math.min(285, Math.floor(w * 0.42)) + 18,
              roleStartY,
              18,
              'font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="12.5" fill="#475569"'
            )}
          </g>
          ${connector}
        `;
      })
      .join('\n');

    bodyMarkup = layersMarkup;
    totalHeight = bodyTop + nodes.length * layerH + (nodes.length - 1) * layerGap + 30;
  } else if (layout === 'hub' && nodes.length >= 2) {
    // Focal hub node at top-center, connected via graceful cubic curves to satellite cards below
    const hubIndex = nodes.length === 3 ? 1 : 0;
    const hubNode = nodes[hubIndex];
    const satellites = nodes.filter((_, idx) => idx !== hubIndex);

    const hubW = 350;
    const hubH = 100;
    const hubX = Math.floor((width - hubW) / 2);
    const hubY = bodyTop + 4;
    const hubTone = NODE_TONES[0];

    const satGap = 20;
    const satCount = satellites.length;
    const satW = Math.min(238, Math.floor((width - padX * 2 - (satCount - 1) * satGap) / satCount));
    const totalSatW = satCount * satW + (satCount - 1) * satGap;
    const satStartX = Math.floor((width - totalSatW) / 2);
    const satY = hubY + hubH + 52;
    const satH = 114;

    const hubLabelLines = wrapSvgText(hubNode.label, 28, 1);
    const hubRoleLines = wrapSvgText(hubNode.role, 36, 2);

    const curvesMarkup = satellites
      .map((_, idx) => {
        const sx = satStartX + idx * (satW + satGap) + satW / 2;
        const startX = hubX + hubW / 2;
        const startY = hubY + hubH;
        const midY = startY + 26;
        const tone = NODE_TONES[(idx + 1) % NODE_TONES.length];
        return `
          <path d="M ${startX} ${startY} C ${startX} ${midY}, ${sx} ${midY}, ${sx} ${satY - 4}" fill="none" stroke="${tone.bar}" stroke-opacity="0.65" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#arrow-${uid})" />
        `;
      })
      .join('\n') + `\n<circle cx="${hubX + hubW / 2}" cy="${hubY + hubH}" r="3.5" fill="${palette.primary}" />`;

    const satMarkup = satellites
      .map((node, idx) => {
        const tone = NODE_TONES[(idx + 1) % NODE_TONES.length];
        const x = satStartX + idx * (satW + satGap);
        const maxLabelChars = Math.max(16, Math.floor((satW - 64) / 7.5));
        const maxRoleChars = Math.max(20, Math.floor((satW - 32) / 6.6));
        const labelLines = wrapSvgText(node.label, maxLabelChars, 2);
        const roleLines = wrapSvgText(node.role, maxRoleChars, 3);
        const labelStartY = labelLines.length > 1 ? satY + 28 : satY + 35;
        const roleY = satY + (labelLines.length > 1 ? 66 : 60);

        return `
          <g filter="url(#shadow-${uid})">
            <rect x="${x}" y="${satY}" width="${satW}" height="${satH}" rx="15" fill="#FFFFFF" stroke="${tone.border}" stroke-width="1.35" />
            <rect x="${x + 14}" y="${satY}" width="${satW - 28}" height="3.5" rx="1.75" fill="${tone.bar}" />
            ${renderIconBadge(x + 14, satY + 15, 30, tone, node.label, node.role, idx + 1)}
            ${renderTextLines(labelLines, x + 52, labelStartY, 16, 'font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="13" font-weight="600" fill="#0F172A"')}
            ${renderTextLines(roleLines, x + 16, roleY, 16, 'font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="11.5" fill="#475569"')}
          </g>
        `;
      })
      .join('\n');

    bodyMarkup = `
      <ellipse cx="${width / 2}" cy="${hubY + hubH / 2}" rx="${Math.round(hubW * 0.62)}" ry="66" fill="url(#hubHalo-${uid})" />
      ${curvesMarkup}
      <g filter="url(#shadowStrong-${uid})">
        <rect x="${hubX}" y="${hubY}" width="${hubW}" height="${hubH}" rx="17" fill="#FFFFFF" stroke="${palette.primary}" stroke-width="1.8" />
        <rect x="${hubX}" y="${hubY}" width="${hubW}" height="${hubH}" rx="17" fill="url(#hubTint-${uid})" />
        ${renderIconBadge(hubX + 18, hubY + 26, 42, hubTone, hubNode.label, hubNode.role, 0)}
        <text x="${hubX + 74}" y="${hubY + 29}" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="10.5" font-weight="700" letter-spacing="0.07em" fill="${palette.badgeText}">CORE ANCHOR</text>
        ${renderTextLines(hubLabelLines, hubX + 74, hubY + 50, 18, 'font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="15" font-weight="600" fill="#0F172A"')}
        ${renderTextLines(hubRoleLines, hubX + 74, hubY + 70, 16, 'font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="12" fill="#475569"')}
      </g>
      ${satMarkup}
    `;

    totalHeight = satY + satH + 30;
  } else {
    // Pipeline layout: numbered elevated cards with smooth directional flow rails
    const gap = 28;
    const cardW = Math.min(226, Math.floor((width - padX * 2 - (nodes.length - 1) * gap) / nodes.length));
    const totalRowW = nodes.length * cardW + (nodes.length - 1) * gap;
    const startX = Math.floor((width - totalRowW) / 2);
    const cardY = bodyTop + 6;
    const cardH = 138;
    const focalIndex = Math.floor(nodes.length / 2);

    bodyMarkup = nodes
      .map((node, index) => {
        const tone = NODE_TONES[index % NODE_TONES.length];
        const x = startX + index * (cardW + gap);
        const isFocal = index === focalIndex && nodes.length >= 3;
        const maxLabelChars = Math.max(15, Math.floor((cardW - 32) / 7.6));
        const maxRoleChars = Math.max(19, Math.floor((cardW - 32) / 6.5));
        const labelLines = wrapSvgText(node.label, maxLabelChars, 2);
        const roleLines = wrapSvgText(node.role, maxRoleChars, 3);
        const labelY = cardY + 66;
        const roleY = labelY + labelLines.length * 18 + 6;

        const connector =
          index < nodes.length - 1
            ? `<g>
                <line x1="${x + cardW + 3}" y1="${cardY + cardH / 2}" x2="${x + cardW + gap - 5}" y2="${cardY + cardH / 2}" stroke="url(#flowGrad-${uid})" stroke-width="2.2" marker-end="url(#arrow-${uid})" />
                <circle cx="${x + cardW + 3}" cy="${cardY + cardH / 2}" r="3" fill="${tone.bar}" />
              </g>`
            : '';

        return `
          <g filter="url(#${isFocal ? `shadowStrong-${uid}` : `shadow-${uid}`})">
            <rect x="${x}" y="${cardY}" width="${cardW}" height="${cardH}" rx="16" fill="#FFFFFF" stroke="${isFocal ? tone.stroke : tone.border}" stroke-width="${isFocal ? '1.75' : '1.3'}" />
            <rect x="${x + 16}" y="${cardY}" width="${cardW - 32}" height="4" rx="2" fill="${tone.bar}" />
            ${renderIconBadge(x + 16, cardY + 16, 32, tone, node.label, node.role, index)}
            <rect x="${x + cardW - 42}" y="${cardY + 20}" width="26" height="20" rx="10" fill="${tone.soft}" />
            <text x="${x + cardW - 29}" y="${cardY + 33.5}" text-anchor="middle" font-family="JetBrains Mono, ui-monospace, monospace" font-size="10.5" font-weight="600" fill="${tone.text}">0${index + 1}</text>
            ${renderTextLines(labelLines, x + 16, labelY, 18, 'font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="13.5" font-weight="600" fill="#0F172A"')}
            ${renderTextLines(roleLines, x + 16, roleY, 16, 'font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="11.5" fill="#475569"')}
          </g>
          ${connector}
        `;
      })
      .join('\n');

    totalHeight = cardY + cardH + 30;
  }

  const badgeText = LAYOUT_BADGE_LABELS[layout];
  const badgeW = Math.round(Math.max(150, badgeText.length * 7.6 + 38));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${totalHeight}" role="img" aria-label="${escapeXml(input.title)}">
  <defs>
    <pattern id="dots-${uid}" width="20" height="20" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1" fill="#CBD5E1" fill-opacity="0.55" />
    </pattern>
    <linearGradient id="bgGrad-${uid}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF" />
      <stop offset="55%" stop-color="#F8FAFC" />
      <stop offset="100%" stop-color="#F1F5F9" />
    </linearGradient>
    <radialGradient id="ambientA-${uid}" cx="92%" cy="8%" r="48%">
      <stop offset="0%" stop-color="${palette.secondaryGlow}" stop-opacity="0.7" />
      <stop offset="100%" stop-color="${palette.secondaryGlow}" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="ambientB-${uid}" cx="6%" cy="94%" r="42%">
      <stop offset="0%" stop-color="#E0E7FF" stop-opacity="0.45" />
      <stop offset="100%" stop-color="#E0E7FF" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="hubHalo-${uid}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${palette.secondaryGlow}" stop-opacity="0.85" />
      <stop offset="100%" stop-color="${palette.secondaryGlow}" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="hubTint-${uid}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${palette.primarySoft}" stop-opacity="0.75" />
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0.1" />
    </linearGradient>
    <linearGradient id="flowGrad-${uid}" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#60A5FA" />
      <stop offset="100%" stop-color="${palette.primary}" />
    </linearGradient>
    <marker id="arrow-${uid}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
      <path d="M 1 1.5 L 9 5 L 1 8.5 z" fill="${palette.primary}" />
    </marker>
    <filter id="shadow-${uid}" x="-8%" y="-10%" width="116%" height="128%">
      <feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#0F172A" flood-opacity="0.06" />
    </filter>
    <filter id="shadowStrong-${uid}" x="-10%" y="-12%" width="120%" height="132%">
      <feDropShadow dx="0" dy="6" stdDeviation="9" flood-color="${palette.primary}" flood-opacity="0.12" />
    </filter>
  </defs>

  <rect width="${width}" height="${totalHeight}" rx="18" fill="url(#bgGrad-${uid})" />
  <rect width="${width}" height="${totalHeight}" rx="18" fill="url(#dots-${uid})" />
  <rect width="${width}" height="${totalHeight}" rx="18" fill="url(#ambientA-${uid})" />
  <rect width="${width}" height="${totalHeight}" rx="18" fill="url(#ambientB-${uid})" />
  <rect x="0.75" y="0.75" width="${width - 1.5}" height="${totalHeight - 1.5}" rx="17.5" fill="none" stroke="#E2E8F0" stroke-width="1.2" />

  <rect x="${padX}" y="${badgeY}" width="${badgeW}" height="24" rx="12" fill="${palette.primarySoft}" stroke="${palette.primaryBorder}" stroke-width="1" />
  <circle cx="${padX + 13}" cy="${badgeY + 12}" r="3.5" fill="${palette.primary}" />
  <text x="${padX + 24}" y="${badgeY + 15.8}" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="10.5" font-weight="700" letter-spacing="0.05em" fill="${palette.badgeText}">${escapeXml(badgeText)}</text>

  ${renderTextLines(titleLines, padX, titleY, 26, 'font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="20" font-weight="650" letter-spacing="-0.02em" fill="#0F172A"')}
  ${renderTextLines(metaphorLines, padX, metaphorY, 19, 'font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="13" fill="#475569"')}

  ${bodyMarkup}
</svg>`;
}

export function isImageGenConfigured(): boolean {
  return getEffectiveVisualSettings().imageGenAvailable;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(str: string, max: number): string {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
