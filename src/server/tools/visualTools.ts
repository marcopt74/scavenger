import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import type { VisualArtifact } from '../../shared/types.js';

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

/**
 * Compiles D2 diagram source to SVG using local `d2` CLI via stdin -> stdout (zero disk writes).
 */
export async function renderD2ToSvg(source: string): Promise<D2RenderResult> {
  const available = await checkD2Available();
  if (!available) {
    return {
      ok: false,
      error: 'Local D2 CLI is not installed on PATH. Install via `brew install d2` or use Mermaid.',
    };
  }

  return new Promise<D2RenderResult>((resolve) => {
    const child = execFile(
      'd2',
      ['-', '-'],
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

export interface ConceptVisualInput {
  title: string;
  metaphor: string;
  caption?: string;
  prompt?: string;
  elements?: Array<{ label: string; role: string }>;
}

/**
 * Generates an optional metaphor/concept visual via Gemini Imagen or OpenAI Images when configured,
 * falling back cleanly to a bespoke minimalist inline SVG concept illustration card.
 */
export async function generateConceptVisual(input: ConceptVisualInput): Promise<VisualArtifact> {
  const id = `vis_${crypto.randomUUID().slice(0, 8)}`;
  const imageGenEnabled = process.env.IMAGE_GEN_ENABLED !== 'false';
  const geminiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const visualPrompt =
    input.prompt ||
    `Clean minimalist editorial architectural metaphor illustration: "${input.title}". Concept: ${input.metaphor}. Flat vector style, soft neutral background (#F8F9FA), crisp slate ink (#1F2937), subtle cobalt accent (#1A73E8), no messy text, clear visual hierarchy.`;

  if (imageGenEnabled && geminiKey) {
    try {
      const model = process.env.GEMINI_IMAGE_MODEL || 'imagen-3.0-generate-002';
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
      const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
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
    ? 'Image generation disabled; rendered vector concept map.'
    : 'Rendered minimalist vector concept map (no raster image API configured or reachable).';

  return {
    id,
    kind: 'concept-image',
    title: input.title,
    caption: input.caption ?? input.metaphor,
    metaphor: input.metaphor,
    svgMarkup: buildFallbackConceptSvg(input),
    isFallback: true,
    fallbackReason,
  };
}

/**
 * Deterministic minimalist SVG concept illustration card used when raster image generation
 * is unavailable, disabled, or fails.
 */
export function buildFallbackConceptSvg(input: ConceptVisualInput): string {
  const nodes = (input.elements && input.elements.length > 0
    ? input.elements.slice(0, 4)
    : [
        { label: 'Input Boundary', role: 'Requests & triggers' },
        { label: 'Core Engine', role: 'Domain logic & state' },
        { label: 'Output Layer', role: 'Artifacts & responses' },
      ]);

  const width = 760;
  const height = 270;
  const cardWidth = Math.min(200, Math.floor((width - 96 - (nodes.length - 1) * 28) / nodes.length));
  const totalRowWidth = nodes.length * cardWidth + (nodes.length - 1) * 28;
  const startX = Math.floor((width - totalRowWidth) / 2);
  const cardY = 128;
  const cardH = 98;

  const nodeMarkup = nodes
    .map((node, index) => {
      const x = startX + index * (cardWidth + 28);
      const nextArrow =
        index < nodes.length - 1
          ? `<line x1="${x + cardWidth + 4}" y1="${cardY + cardH / 2}" x2="${x + cardWidth + 22}" y2="${cardY + cardH / 2}" stroke="#94A3B8" stroke-width="1.75" marker-end="url(#arrow)" />`
          : '';
      const accent = index === Math.floor(nodes.length / 2) ? '#1A73E8' : '#E2E8F0';
      const fill = index === Math.floor(nodes.length / 2) ? '#EEF4FF' : '#FFFFFF';

      return `
        <g>
          <rect x="${x}" y="${cardY}" width="${cardWidth}" height="${cardH}" rx="14" fill="${fill}" stroke="${accent}" stroke-width="1.5" />
          <circle cx="${x + 20}" cy="${cardY + 24}" r="5" fill="${index === Math.floor(nodes.length / 2) ? '#1A73E8' : '#64748B'}" />
          <text x="${x + 34}" y="${cardY + 28}" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600" fill="#1F2937">${escapeXml(truncate(node.label, 22))}</text>
          <text x="${x + 16}" y="${cardY + 56}" font-family="Inter, system-ui, sans-serif" font-size="11.5" fill="#475569">${escapeXml(truncate(node.role, 26))}</text>
          <text x="${x + 16}" y="${cardY + 75}" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#64748B">${escapeXml(truncate(node.role.slice(26), 26))}</text>
        </g>
        ${nextArrow}
      `;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(input.title)}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#94A3B8" />
    </marker>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#F8FAFC" />
      <stop offset="100%" stop-color="#F1F5F9" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="18" fill="url(#bgGrad)" stroke="#E2E8F0" stroke-width="1" />
  <rect x="28" y="24" width="112" height="24" rx="12" fill="#E8F0FE" />
  <text x="84" y="40" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" font-weight="600" fill="#1A73E8">MENTAL MODEL</text>
  <text x="28" y="76" font-family="Inter, system-ui, sans-serif" font-size="19" font-weight="600" fill="#0F172A">${escapeXml(truncate(input.title, 58))}</text>
  <text x="28" y="102" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#475569">${escapeXml(truncate(input.metaphor, 88))}</text>
  ${nodeMarkup}
</svg>`;
}

export function isImageGenConfigured(): boolean {
  if (process.env.IMAGE_GEN_ENABLED === 'false') return false;
  return Boolean(
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.OPENAI_API_KEY
  );
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
