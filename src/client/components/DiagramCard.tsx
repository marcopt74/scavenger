import { Check, Copy, Download, ImageDown, Maximize2, PenTool, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { renderD2Diagram } from '../api/client';
import {
  downloadSvgAsPng,
  downloadSvgMarkup,
  prepareSvgForLightbox,
  renderMermaidSvg,
} from '../utils/mermaidTheme';
import type { MermaidLook } from '../utils/mermaidTheme';
import { getDocumentTheme, THEME_CHANGE_EVENT } from '../utils/theme';
import type { ThemeMode } from '../utils/theme';
import { VisualLightbox } from './VisualLightbox';

export interface DiagramCardProps {
  format: 'mermaid' | 'd2';
  title: string;
  caption?: string;
  source: string;
  preRenderedSvg?: string;
  preRenderError?: string;
}

export function DiagramCard({
  format,
  title,
  caption,
  source,
  preRenderedSvg,
  preRenderError,
}: DiagramCardProps) {
  const [look, setLook] = useState<MermaidLook>('classic');
  const [theme, setTheme] = useState<ThemeMode>(() => getDocumentTheme());
  const [svg, setSvg] = useState<string | null>(preRenderedSvg ?? null);
  const [error, setError] = useState<string | null>(preRenderError ?? null);
  const [loading, setLoading] = useState<boolean>(!preRenderedSvg && !preRenderError);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function handleThemeChange(e: Event) {
      const custom = e as CustomEvent<ThemeMode>;
      setTheme(custom.detail ?? getDocumentTheme());
    }
    window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
  }, []);

  useEffect(() => {
    if (format === 'd2' && (preRenderedSvg || preRenderError)) {
      setSvg(preRenderedSvg ?? null);
      setError(preRenderError ?? null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    async function render() {
      try {
        if (format === 'mermaid') {
          const renderedSvg = await renderMermaidSvg(source, look, theme);
          if (!cancelled) {
            setSvg(renderedSvg);
            setLoading(false);
          }
        } else {
          const res = await renderD2Diagram(source);
          if (!cancelled) {
            if (res.ok && res.svg) {
              setSvg(res.svg);
            } else {
              setError(res.error || 'D2 renderer is unavailable on this machine.');
            }
            setLoading(false);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to render diagram visually.');
          setLoading(false);
        }
      }
    }

    void render();
    return () => {
      cancelled = true;
    };
  }, [format, source, look, theme, preRenderedSvg, preRenderError]);

  async function handleCopySource() {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard denial
    }
  }

  const badgeLabel = format === 'mermaid' ? 'Diagram' : 'D2';
  const badgeClass = format === 'mermaid' ? 'kind-mermaid' : 'kind-d2';
  const lightboxSvg = useMemo(
    () => (expanded && svg ? prepareSvgForLightbox(svg) : null),
    [expanded, svg]
  );

  return (
    <>
      <figure className="visual-card" style={{ margin: 0 }}>
        <div className="visual-card-header">
          <div className="visual-card-title-group">
            <span className={`visual-kind-badge ${badgeClass}`}>{badgeLabel}</span>
            <span className="visual-card-title" title={title}>
              {title}
            </span>
          </div>

          <div className="visual-card-actions">
            {format === 'mermaid' && svg && (
              <button
                type="button"
                className={`visual-action-btn ${look === 'handDrawn' ? 'is-active' : ''}`}
                onClick={() => setLook((prev) => (prev === 'classic' ? 'handDrawn' : 'classic'))}
                title={
                  look === 'handDrawn'
                    ? 'Switch to crisp architectural vector style'
                    : 'Switch to whiteboard sketch style'
                }
              >
                {look === 'handDrawn' ? <Sparkles size={13} /> : <PenTool size={13} />}
                <span>{look === 'handDrawn' ? 'Clean' : 'Sketch'}</span>
              </button>
            )}

            <button
              type="button"
              className="visual-action-btn"
              onClick={() => void handleCopySource()}
              title="Copy diagram source"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? 'Copied' : 'Source'}</span>
            </button>

            {svg && (
              <>
                <button
                  type="button"
                  className="visual-action-btn"
                  onClick={() => downloadSvgMarkup(svg, title)}
                  title="Download SVG"
                >
                  <Download size={13} />
                  <span>SVG</span>
                </button>
                <button
                  type="button"
                  className="visual-action-btn"
                  onClick={() => void downloadSvgAsPng(svg, title)}
                  title="Download 2x PNG"
                >
                  <ImageDown size={13} />
                  <span>PNG</span>
                </button>
                <button
                  type="button"
                  className="visual-action-btn"
                  onClick={() => setExpanded(true)}
                  title="Expand diagram with zoom & pan"
                >
                  <Maximize2 size={13} />
                  <span>Expand</span>
                </button>
              </>
            )}
          </div>
        </div>

        <div className="visual-card-body diagram-canvas">
          {loading && !svg ? (
            <div className="visual-skeleton" aria-label="Rendering diagram">
              <div className="visual-skeleton-row">
                <div className="visual-skeleton-box" />
                <div className="visual-skeleton-line" />
                <div className="visual-skeleton-box wide" />
                <div className="visual-skeleton-line" />
                <div className="visual-skeleton-box" />
              </div>
              <span className="visual-skeleton-label">Rendering diagram…</span>
            </div>
          ) : svg ? (
            <div
              className={`visual-svg-host diagram-svg-host ${loading ? 'is-refreshing' : ''}`}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
            <div className="visual-fallback-box">
              <p className="visual-fallback-note">
                <strong>Visual fallback:</strong> Could not render this {format.toUpperCase()} diagram
                directly ({error || 'renderer unavailable'}).
              </p>
              <details className="visual-source-details">
                <summary>Inspect diagram source</summary>
                <pre>
                  <code>{source}</code>
                </pre>
              </details>
            </div>
          )}
        </div>

        {caption && <figcaption className="visual-card-caption">{caption}</figcaption>}
      </figure>

      {expanded && svg && lightboxSvg && (
        <VisualLightbox
          title={title}
          badge={badgeLabel}
          badgeClass={badgeClass}
          caption={caption}
          canvasStyle="diagram"
          onDownloadSecondary={() => downloadSvgMarkup(svg, title)}
          downloadSecondaryLabel="SVG"
          onDownloadPrimary={() => void downloadSvgAsPng(svg, title)}
          downloadPrimaryLabel="PNG"
          onClose={() => setExpanded(false)}
        >
          <div
            className="lightbox-svg-inner"
            dangerouslySetInnerHTML={{ __html: lightboxSvg }}
          />
        </VisualLightbox>
      )}
    </>
  );
}
