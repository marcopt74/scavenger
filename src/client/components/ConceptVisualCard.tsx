import { Maximize2, X } from 'lucide-react';
import { useState } from 'react';
import type { VisualArtifact } from '../../shared/types';

type ConceptVisual = Extract<VisualArtifact, { kind: 'concept-image' }>;

export function ConceptVisualCard({ visual }: { visual: ConceptVisual }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <figure className="visual-card" style={{ margin: 0 }}>
        <div className="visual-card-header">
          <div className="visual-card-title-group">
            <span className="visual-kind-badge">
              {visual.isFallback ? 'Concept Map' : 'Concept Visual'}
            </span>
            <span className="visual-card-title">{visual.title}</span>
          </div>
          <div className="visual-card-actions">
            <button
              type="button"
              className="visual-action-btn"
              onClick={() => setExpanded(true)}
              title="Expand visual"
            >
              <Maximize2 size={14} />
              <span>Expand</span>
            </button>
          </div>
        </div>

        <div className="visual-card-body">
          {visual.imageDataUrl ? (
            <img
              src={visual.imageDataUrl}
              alt={visual.title}
              className="visual-raster-img"
            />
          ) : visual.svgMarkup ? (
            <div
              className="visual-svg-host"
              dangerouslySetInnerHTML={{ __html: visual.svgMarkup }}
            />
          ) : (
            <div className="visual-fallback-box">
              <p className="visual-fallback-note">{visual.metaphor || visual.title}</p>
            </div>
          )}
        </div>

        {(visual.caption || visual.metaphor) && (
          <figcaption className="visual-card-caption">
            {visual.caption || visual.metaphor}
          </figcaption>
        )}
      </figure>

      {expanded && (
        <div className="modal-backdrop" onClick={() => setExpanded(false)}>
          <div className="lightbox-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{visual.title}</h3>
              <button
                type="button"
                className="icon-button"
                onClick={() => setExpanded(false)}
                aria-label="Close expanded visual"
              >
                <X size={18} />
              </button>
            </div>
            <div className="lightbox-body">
              {visual.imageDataUrl ? (
                <img
                  src={visual.imageDataUrl}
                  alt={visual.title}
                  style={{ maxWidth: '100%', maxHeight: '72vh', borderRadius: 12 }}
                />
              ) : visual.svgMarkup ? (
                <div
                  style={{ width: '100%', maxWidth: 920 }}
                  dangerouslySetInnerHTML={{ __html: visual.svgMarkup }}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
