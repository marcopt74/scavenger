import { Download, Maximize2, X } from 'lucide-react';
import mermaid from 'mermaid';
import { useEffect, useId, useState } from 'react';
import { renderD2Diagram } from '../api/client';

let mermaidInitialized = false;

function ensureMermaidInit(): void {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
    themeVariables: {
      primaryColor: '#eef4ff',
      primaryTextColor: '#1f2937',
      primaryBorderColor: '#93c5fd',
      lineColor: '#64748b',
      secondaryColor: '#f8fafc',
      tertiaryColor: '#f1f5f9',
      edgeLabelBackground: '#ffffff',
      fontSize: '13.5px',
    },
  });
  mermaidInitialized = true;
}

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
  const uniqueId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [svg, setSvg] = useState<string | null>(preRenderedSvg ?? null);
  const [error, setError] = useState<string | null>(preRenderError ?? null);
  const [loading, setLoading] = useState<boolean>(!preRenderedSvg && !preRenderError);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (preRenderedSvg || preRenderError) {
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
          ensureMermaidInit();
          const renderId = `mmd_${uniqueId}_${Date.now()}`;
          const { svg: renderedSvg } = await mermaid.render(renderId, source.trim());
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
  }, [format, source, preRenderedSvg, preRenderError, uniqueId]);

  function handleDownloadSvg() {
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'diagram'}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <figure className="visual-card" style={{ margin: 0 }}>
        <div className="visual-card-header">
          <div className="visual-card-title-group">
            <span className="visual-kind-badge">{format.toUpperCase()}</span>
            <span className="visual-card-title">{title}</span>
          </div>
          {svg && (
            <div className="visual-card-actions">
              <button
                type="button"
                className="visual-action-btn"
                onClick={handleDownloadSvg}
                title="Download SVG"
              >
                <Download size={14} />
                <span>SVG</span>
              </button>
              <button
                type="button"
                className="visual-action-btn"
                onClick={() => setExpanded(true)}
                title="Expand diagram"
              >
                <Maximize2 size={14} />
                <span>Expand</span>
              </button>
            </div>
          )}
        </div>

        <div className="visual-card-body">
          {loading ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '18px 0' }}>
              Rendering visual diagram…
            </div>
          ) : svg ? (
            <div
              className="visual-svg-host"
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

      {expanded && svg && (
        <div className="modal-backdrop" onClick={() => setExpanded(false)}>
          <div className="lightbox-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{title}</h3>
              <button
                type="button"
                className="icon-button"
                onClick={() => setExpanded(false)}
                aria-label="Close expanded diagram"
              >
                <X size={18} />
              </button>
            </div>
            <div
              className="lightbox-body"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </div>
      )}
    </>
  );
}
