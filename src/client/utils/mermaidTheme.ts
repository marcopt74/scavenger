import mermaid from 'mermaid';
import type { MermaidConfig } from 'mermaid';
import { getDocumentTheme } from './theme';
import type { ThemeMode } from './theme';

export type MermaidLook = 'classic' | 'handDrawn';

const SEMANTIC_CLASS_DEFS: Record<string, string> = {
  entry: 'classDef entry fill:#EFF6FF,stroke:#2563EB,stroke-width:1.75px,color:#1E3A8A',
  core: 'classDef core fill:#EEF2FF,stroke:#4F46E5,stroke-width:1.75px,color:#312E81',
  guard: 'classDef guard fill:#F0FDFA,stroke:#0D9488,stroke-width:1.75px,color:#115E59',
  data: 'classDef data fill:#FFFBEB,stroke:#D97706,stroke-width:1.75px,color:#78350F',
  external: 'classDef external fill:#F8FAFC,stroke:#64748B,stroke-width:1.5px,color:#334155',
};

const SEMANTIC_DARK_CLASS_DEFS: Record<string, string> = {
  entry: 'classDef entry fill:#1E3A8A,stroke:#60A5FA,stroke-width:1.75px,color:#EFF6FF',
  core: 'classDef core fill:#312E81,stroke:#818CF8,stroke-width:1.75px,color:#EEF2FF',
  guard: 'classDef guard fill:#134E4A,stroke:#2DD4BF,stroke-width:1.75px,color:#F0FDFA',
  data: 'classDef data fill:#78350F,stroke:#FBBF24,stroke-width:1.75px,color:#FFFBEB',
  external: 'classDef external fill:#1E293B,stroke:#94A3B8,stroke-width:1.5px,color:#E2E8F0',
};

const EDITORIAL_THEME_CSS = `
  svg,
  text,
  tspan,
  .label,
  .nodeLabel,
  .edgeLabel,
  .cluster-label,
  .messageText,
  .noteText {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
    text-rendering: geometricPrecision !important;
    -webkit-font-smoothing: antialiased !important;
    -moz-osx-font-smoothing: grayscale !important;
    font-feature-settings: 'cv02' 1, 'cv03' 1, 'cv04' 1, 'cv05' 1, 'cv08' 1, 'cv11' 1, 'ss01' 1, 'calt' 1, 'liga' 1, 'kern' 1 !important;
    font-kerning: normal !important;
  }
  .node .label text,
  .nodeLabel {
    fill: #0F172A !important;
    color: #0F172A !important;
    font-weight: 540 !important;
    letter-spacing: -0.01em !important;
  }
  .node rect,
  .node polygon,
  .node circle {
    filter: drop-shadow(0 2px 5px rgba(15, 23, 42, 0.06));
  }
  .node rect {
    rx: 10px;
    ry: 10px;
  }
  .cluster rect {
    rx: 14px !important;
    ry: 14px !important;
    fill: rgba(248, 250, 252, 0.86) !important;
    stroke: #CBD5E1 !important;
    stroke-width: 1.35px !important;
    stroke-dasharray: 5 4 !important;
  }
  .cluster-label text,
  .cluster-label span {
    fill: #475569 !important;
    color: #475569 !important;
    font-weight: 600 !important;
    font-size: 12px !important;
  }
  .edgePath .path {
    stroke: #64748B !important;
    stroke-width: 1.7px !important;
  }
  .edgeLabel rect {
    rx: 6px;
    ry: 6px;
    fill: #FFFFFF !important;
    stroke: #E2E8F0 !important;
    stroke-width: 1px !important;
    opacity: 0.96 !important;
  }
  .edgeLabel text,
  .edgeLabel span {
    fill: #475569 !important;
    color: #475569 !important;
    font-size: 11.5px !important;
    font-weight: 500 !important;
  }
  .actor {
    rx: 10px !important;
    ry: 10px !important;
    filter: drop-shadow(0 2px 5px rgba(15, 23, 42, 0.06));
  }
  text.actor > tspan {
    font-weight: 600 !important;
  }
  .actor-line {
    stroke: #CBD5E1 !important;
    stroke-dasharray: 4 4 !important;
  }
  .messageLine0,
  .messageLine1 {
    stroke: #475569 !important;
    stroke-width: 1.6px !important;
  }
  .messageText {
    fill: #1E293B !important;
    font-size: 12.5px !important;
    font-weight: 500 !important;
  }
  .note {
    rx: 8px !important;
    ry: 8px !important;
    fill: #FFFBEB !important;
    stroke: #FCD34D !important;
    stroke-width: 1.25px !important;
    filter: drop-shadow(0 2px 4px rgba(180, 83, 9, 0.06));
  }
  .noteText,
  .noteText > tspan {
    fill: #78350F !important;
    font-size: 12px !important;
    font-weight: 500 !important;
  }
  .sequenceNumber {
    fill: #FFFFFF !important;
    font-weight: 700 !important;
  }
`;

const EDITORIAL_DARK_THEME_CSS = `
  svg,
  text,
  tspan,
  .label,
  .nodeLabel,
  .edgeLabel,
  .cluster-label,
  .messageText,
  .noteText {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
    text-rendering: geometricPrecision !important;
    -webkit-font-smoothing: antialiased !important;
    -moz-osx-font-smoothing: grayscale !important;
    font-feature-settings: 'cv02' 1, 'cv03' 1, 'cv04' 1, 'cv05' 1, 'cv08' 1, 'cv11' 1, 'ss01' 1, 'calt' 1, 'liga' 1, 'kern' 1 !important;
    font-kerning: normal !important;
  }
  .node .label text,
  .nodeLabel {
    fill: #F1F5F9 !important;
    color: #F1F5F9 !important;
    font-weight: 540 !important;
    letter-spacing: -0.01em !important;
  }
  .node rect,
  .node polygon,
  .node circle {
    filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.36));
  }
  .node rect {
    rx: 10px;
    ry: 10px;
  }
  .cluster rect {
    rx: 14px !important;
    ry: 14px !important;
    fill: rgba(22, 29, 39, 0.88) !important;
    stroke: #36455C !important;
    stroke-width: 1.35px !important;
    stroke-dasharray: 5 4 !important;
  }
  .cluster-label text,
  .cluster-label span {
    fill: #94A3B8 !important;
    color: #94A3B8 !important;
    font-weight: 600 !important;
    font-size: 12px !important;
  }
  .edgePath .path {
    stroke: #94A3B8 !important;
    stroke-width: 1.7px !important;
  }
  .edgeLabel rect {
    rx: 6px;
    ry: 6px;
    fill: #161D27 !important;
    stroke: #36455C !important;
    stroke-width: 1px !important;
    opacity: 0.96 !important;
  }
  .edgeLabel text,
  .edgeLabel span {
    fill: #CBD5E1 !important;
    color: #CBD5E1 !important;
    font-size: 11.5px !important;
    font-weight: 500 !important;
  }
  .actor {
    rx: 10px !important;
    ry: 10px !important;
    filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.36));
  }
  text.actor > tspan {
    font-weight: 600 !important;
  }
  .actor-line {
    stroke: #475569 !important;
    stroke-dasharray: 4 4 !important;
  }
  .messageLine0,
  .messageLine1 {
    stroke: #94A3B8 !important;
    stroke-width: 1.6px !important;
  }
  .messageText {
    fill: #E2E8F0 !important;
    font-size: 12.5px !important;
    font-weight: 500 !important;
  }
  .note {
    rx: 8px !important;
    ry: 8px !important;
    fill: #422006 !important;
    stroke: #D97706 !important;
    stroke-width: 1.25px !important;
  }
  .noteText,
  .noteText > tspan {
    fill: #FDE68A !important;
    font-size: 12px !important;
    font-weight: 500 !important;
  }
  .sequenceNumber {
    fill: #0F141C !important;
    font-weight: 700 !important;
  }
`;

function getMermaidConfig(look: MermaidLook, theme: ThemeMode = 'light'): MermaidConfig {
  if (theme === 'dark') {
    return {
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      look,
      handDrawnSeed: 7,
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      flowchart: {
        curve: 'basis',
        padding: 18,
        nodeSpacing: 48,
        rankSpacing: 58,
        htmlLabels: false,
        useMaxWidth: true,
      },
      sequence: {
        mirrorActors: false,
        actorMargin: 56,
        messageMargin: 44,
        boxMargin: 12,
        noteMargin: 14,
        useMaxWidth: true,
      },
      themeVariables: {
        background: '#111722',
        primaryColor: '#1E293B',
        primaryTextColor: '#F1F5F9',
        primaryBorderColor: '#60A5FA',
        secondaryColor: '#161D27',
        secondaryTextColor: '#E2E8F0',
        secondaryBorderColor: '#475569',
        tertiaryColor: '#134E4A',
        tertiaryTextColor: '#CCFBF1',
        tertiaryBorderColor: '#2DD4BF',
        lineColor: '#94A3B8',
        textColor: '#E2E8F0',
        mainBkg: '#1E293B',
        nodeBorder: '#60A5FA',
        clusterBkg: '#161D27',
        clusterBorder: '#36455C',
        defaultLinkColor: '#94A3B8',
        titleColor: '#F1F5F9',
        edgeLabelBackground: '#161D27',
        actorBkg: '#1E293B',
        actorBorder: '#60A5FA',
        actorTextColor: '#EFF6FF',
        actorLineColor: '#475569',
        signalColor: '#94A3B8',
        signalTextColor: '#E2E8F0',
        labelBoxBkgColor: '#161D27',
        labelBoxBorderColor: '#36455C',
        labelTextColor: '#CBD5E1',
        activationBkgColor: '#1E3A8A',
        activationBorderColor: '#60A5FA',
        noteBkgColor: '#422006',
        noteBorderColor: '#D97706',
        noteTextColor: '#FDE68A',
        cScale0: '#1E3A8A',
        cScale1: '#312E81',
        cScale2: '#134E4A',
        cScale3: '#78350F',
        cScale4: '#1E293B',
        fontSize: '13.5px',
      },
      themeCSS: EDITORIAL_DARK_THEME_CSS,
    };
  }

  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    look,
    handDrawnSeed: 7,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    flowchart: {
      curve: 'basis',
      padding: 18,
      nodeSpacing: 48,
      rankSpacing: 58,
      htmlLabels: false,
      useMaxWidth: true,
    },
    sequence: {
      mirrorActors: false,
      actorMargin: 56,
      messageMargin: 44,
      boxMargin: 12,
      noteMargin: 14,
      useMaxWidth: true,
    },
    themeVariables: {
      background: '#FFFFFF',
      primaryColor: '#EFF6FF',
      primaryTextColor: '#0F172A',
      primaryBorderColor: '#93C5FD',
      secondaryColor: '#F8FAFC',
      secondaryTextColor: '#1E293B',
      secondaryBorderColor: '#CBD5E1',
      tertiaryColor: '#F0FDFA',
      tertiaryTextColor: '#115E59',
      tertiaryBorderColor: '#99F6E4',
      lineColor: '#64748B',
      textColor: '#1E293B',
      mainBkg: '#EFF6FF',
      nodeBorder: '#93C5FD',
      clusterBkg: '#F8FAFC',
      clusterBorder: '#CBD5E1',
      defaultLinkColor: '#64748B',
      titleColor: '#0F172A',
      edgeLabelBackground: '#FFFFFF',
      actorBkg: '#EFF6FF',
      actorBorder: '#3B82F6',
      actorTextColor: '#1E3A8A',
      actorLineColor: '#CBD5E1',
      signalColor: '#475569',
      signalTextColor: '#1E293B',
      labelBoxBkgColor: '#F8FAFC',
      labelBoxBorderColor: '#CBD5E1',
      labelTextColor: '#334155',
      activationBkgColor: '#DBEAFE',
      activationBorderColor: '#2563EB',
      noteBkgColor: '#FFFBEB',
      noteBorderColor: '#FCD34D',
      noteTextColor: '#78350F',
      cScale0: '#EFF6FF',
      cScale1: '#EEF2FF',
      cScale2: '#F0FDFA',
      cScale3: '#FFFBEB',
      cScale4: '#F8FAFC',
      fontSize: '13.5px',
    },
    themeCSS: EDITORIAL_THEME_CSS,
  };
}

/**
 * Automatically appends native Mermaid `classDef` declarations for any referenced
 * semantic classes (`:::entry`, `:::core`, `:::guard`, `:::data`, `:::external`)
 * on flowchart/graph diagrams when not already declared. Works seamlessly in both
 * `classic` and `handDrawn` (RoughJS) looks as well as exported SVGs/PNGs.
 */
function enrichFlowchartSemantics(source: string, theme: ThemeMode = 'light'): string {
  const trimmed = source.trim();
  const strippedDirectives = trimmed.replace(/^%%\{[\s\S]*?\}%%\s*/, '').trimStart();
  if (!/^(flowchart|graph)\b/i.test(strippedDirectives)) {
    return trimmed;
  }

  const defs = theme === 'dark' ? SEMANTIC_DARK_CLASS_DEFS : SEMANTIC_CLASS_DEFS;
  const additions: string[] = [];
  for (const [name, def] of Object.entries(defs)) {
    const isReferenced =
      new RegExp(`:::${name}\\b`).test(trimmed) ||
      new RegExp(`^\\s*class\\s+[^\\n]+\\s+${name}\\b`, 'm').test(trimmed);
    const isDeclared = new RegExp(`^\\s*classDef\\s+${name}\\b`, 'm').test(trimmed);
    if (isReferenced && !isDeclared) {
      additions.push(`  ${def}`);
    }
  }

  if (additions.length === 0) {
    return trimmed;
  }
  return `${trimmed}\n${additions.join('\n')}`;
}

// Serialize mermaid.initialize + mermaid.render so concurrent cards never race on global config
let renderQueue: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

export function renderMermaidSvg(
  source: string,
  look: MermaidLook = 'classic',
  theme: ThemeMode = getDocumentTheme()
): Promise<string> {
  const run = async (): Promise<string> => {
    mermaid.initialize(getMermaidConfig(look, theme));
    const prepared = enrichFlowchartSemantics(source, theme);
    const id = `mmd_scav_${++renderSeq}_${Date.now()}`;
    const { svg } = await mermaid.render(id, prepared);
    return svg;
  };

  const task = renderQueue.then(run, run);
  renderQueue = task.catch(() => {});
  return task;
}

export function slugifyFilename(title: string, fallback = 'visual'): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || fallback
  );
}

export function downloadSvgMarkup(svgMarkup: string, title: string): void {
  const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugifyFilename(title, 'diagram')}.svg`;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadDataUrl(dataUrl: string, title: string, ext = 'png'): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${slugifyFilename(title, 'concept')}.${ext}`;
  a.click();
}

/**
 * Prepares an inline SVG string for rendering inside the zoom/pan Lightbox:
 * 1. Computes explicit pixel dimensions from `viewBox` scaled to fit the viewport
 *    (preventing Mermaid's `width="100%"` SVGs from collapsing to 0x0 inside flex containers).
 * 2. Re-scopes internal `id` attributes and `#id` / `url(#id)` references with a `-lb` suffix
 *    so the lightbox SVG never collides with the inline card SVG in the same DOM.
 */
export function prepareSvgForLightbox(svgMarkup: string): string {
  try {
    if (typeof document === 'undefined') {
      return svgMarkup;
    }
    const host = document.createElement('div');
    host.innerHTML = svgMarkup;
    const svgEl = host.querySelector('svg');
    if (!svgEl) {
      return svgMarkup;
    }

    // 1. Extract natural dimensions from viewBox (or numeric width/height fallback)
    let naturalW = 0;
    let naturalH = 0;
    const viewBox = svgEl.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        naturalW = parts[2];
        naturalH = parts[3];
      }
    }

    if (naturalW <= 0 || naturalH <= 0) {
      const wAttr = Number.parseFloat(svgEl.getAttribute('width') || '');
      const hAttr = Number.parseFloat(svgEl.getAttribute('height') || '');
      if (Number.isFinite(wAttr) && wAttr > 0 && Number.isFinite(hAttr) && hAttr > 0) {
        naturalW = wAttr;
        naturalH = hAttr;
        if (!viewBox) {
          svgEl.setAttribute('viewBox', `0 0 ${naturalW} ${naturalH}`);
        }
      }
    }

    if (naturalW > 0 && naturalH > 0) {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
      const maxW = Math.min(vw * 0.84, 1080);
      const maxH = vh * 0.68;
      const fitScale = Math.min(maxW / naturalW, maxH / naturalH, 1.4);
      const fittedW = Math.max(120, Math.round(naturalW * fitScale));
      const fittedH = Math.max(80, Math.round(naturalH * fitScale));

      svgEl.setAttribute('width', String(fittedW));
      svgEl.setAttribute('height', String(fittedH));
      svgEl.style.width = `${fittedW}px`;
      svgEl.style.height = `${fittedH}px`;
      svgEl.style.maxWidth = 'none';
      svgEl.style.maxHeight = 'none';
    }

    // 2. Re-scope all IDs to prevent DOM collisions with the inline SVG card
    const allElements: Element[] = [svgEl, ...Array.from(svgEl.querySelectorAll('*'))];
    const idMap = new Map<string, string>();
    for (const el of allElements) {
      const oldId = el.getAttribute('id');
      if (oldId) {
        const nextId = `${oldId}-lb`;
        idMap.set(oldId, nextId);
        el.setAttribute('id', nextId);
      }
    }

    if (idMap.size > 0) {
      const replaceUrlRefs = (val: string) =>
        val.replace(/url\(\s*(['"]?)#([^)'"]+)\1\s*\)/g, (full, quote: string, name: string) =>
          idMap.has(name) ? `url(${quote}#${idMap.get(name)}${quote})` : full
        );

      for (const el of allElements) {
        for (const attr of Array.from(el.attributes)) {
          if (attr.name === 'id') continue;
          if (attr.name === 'href' || attr.name === 'xlink:href') {
            if (attr.value.startsWith('#')) {
              const target = attr.value.slice(1);
              if (idMap.has(target)) {
                el.setAttribute(attr.name, `#${idMap.get(target)}`);
              }
            }
          } else if (attr.value.includes('url(')) {
            const updated = replaceUrlRefs(attr.value);
            if (updated !== attr.value) {
              el.setAttribute(attr.name, updated);
            }
          }
        }
      }

      for (const styleEl of Array.from(svgEl.querySelectorAll('style'))) {
        const css = styleEl.textContent || '';
        const updatedCss = replaceUrlRefs(css).replace(
          /#([A-Za-z_][A-Za-z0-9_:-]*)/g,
          (full, name: string) => (idMap.has(name) ? `#${idMap.get(name)}` : full)
        );
        styleEl.textContent = updatedCss;
      }
    }

    return svgEl.outerHTML;
  } catch {
    return svgMarkup;
  }
}

/**
 * Exports any self-contained SVG markup as a crisp 2x Retina PNG image.
 * Falls back gracefully to SVG download if browser canvas serialization fails.
 */
export async function downloadSvgAsPng(
  svgMarkup: string,
  title: string,
  scale = 2
): Promise<void> {
  try {
    const host = document.createElement('div');
    host.innerHTML = svgMarkup;
    const svgEl = host.querySelector('svg');
    if (!svgEl) {
      downloadSvgMarkup(svgMarkup, title);
      return;
    }

    if (!svgEl.getAttribute('xmlns')) {
      svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }

    let width = 800;
    let height = 450;
    const viewBox = svgEl.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        width = Math.ceil(parts[2]);
        height = Math.ceil(parts[3]);
      }
    } else {
      const wAttr = Number.parseFloat(svgEl.getAttribute('width') || '');
      const hAttr = Number.parseFloat(svgEl.getAttribute('height') || '');
      if (Number.isFinite(wAttr) && wAttr > 0) width = Math.ceil(wAttr);
      if (Number.isFinite(hAttr) && hAttr > 0) height = Math.ceil(hAttr);
    }

    svgEl.setAttribute('width', String(width));
    svgEl.setAttribute('height', String(height));

    const serialized = new XMLSerializer().serializeToString(svgEl);
    const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Failed to load SVG into image element.'));
      image.src = dataUri;
    });

    const pad = 24;
    const canvas = document.createElement('canvas');
    canvas.width = (width + pad * 2) * scale;
    canvas.height = (height + pad * 2) * scale;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      downloadSvgMarkup(svgMarkup, title);
      return;
    }

    ctx.scale(scale, scale);
    ctx.fillStyle = getDocumentTheme() === 'dark' ? '#111722' : '#FFFFFF';
    ctx.fillRect(0, 0, width + pad * 2, height + pad * 2);
    ctx.drawImage(img, pad, pad, width, height);

    const pngUrl = canvas.toDataURL('image/png');
    downloadDataUrl(pngUrl, title, 'png');
  } catch {
    downloadSvgMarkup(svgMarkup, title);
  }
}
