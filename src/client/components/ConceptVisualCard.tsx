import { Download, ImageDown, Maximize2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { VisualArtifact } from '../../shared/types';
import {
  downloadDataUrl,
  downloadSvgAsPng,
  downloadSvgMarkup,
  prepareSvgForLightbox,
} from '../utils/mermaidTheme';
import { VisualLightbox } from './VisualLightbox';

type ConceptVisual = Extract<VisualArtifact, { kind: 'concept-image' }>;

export function ConceptVisualCard({ visual }: { visual: ConceptVisual }) {
  const [expanded, setExpanded] = useState(false);

  const badgeLabel = visual.isFallback ? 'Mental Model' : 'Concept Art';
  const badgeClass = 'kind-concept';
  const hasRaster = Boolean(visual.imageDataUrl);
  const hasSvg = Boolean(visual.svgMarkup);
  const lightboxSvg = useMemo(
    () => (expanded && !hasRaster && visual.svgMarkup ? prepareSvgForLightbox(visual.svgMarkup) : null),
    [expanded, hasRaster, visual.svgMarkup]
  );

  return (
    <>
      <figure className="visual-card concept-card" style={{ margin: 0 }}>
        <div className="visual-card-header">
          <div className="visual-card-title-group">
            <span className={`visual-kind-badge ${badgeClass}`}>{badgeLabel}</span>
            <span className="visual-card-title" title={visual.title}>
              {visual.title}
            </span>
          </div>

          <div className="visual-card-actions">
            {hasSvg && !hasRaster && (
              <>
                <button
                  type="button"
                  className="visual-action-btn"
                  onClick={() => downloadSvgMarkup(visual.svgMarkup!, visual.title)}
                  title="Download SVG"
                >
                  <Download size={13} />
                  <span>SVG</span>
                </button>
                <button
                  type="button"
                  className="visual-action-btn"
                  onClick={() => void downloadSvgAsPng(visual.svgMarkup!, visual.title)}
                  title="Download 2x PNG"
                >
                  <ImageDown size={13} />
                  <span>PNG</span>
                </button>
              </>
            )}

            {hasRaster && (
              <button
                type="button"
                className="visual-action-btn"
                onClick={() => downloadDataUrl(visual.imageDataUrl!, visual.title, 'png')}
                title="Download PNG illustration"
              >
                <Download size={13} />
                <span>PNG</span>
              </button>
            )}

            {(hasRaster || hasSvg) && (
              <button
                type="button"
                className="visual-action-btn"
                onClick={() => setExpanded(true)}
                title="Expand visual with zoom & pan"
              >
                <Maximize2 size={13} />
                <span>Expand</span>
              </button>
            )}
          </div>
        </div>

        <div className="visual-card-body concept-stage">
          {hasRaster ? (
            <div className="concept-raster-frame">
              <img
                src={visual.imageDataUrl}
                alt={visual.title}
                className="visual-raster-img"
              />
            </div>
          ) : hasSvg ? (
            <div
              className="visual-svg-host concept-svg-host"
              dangerouslySetInnerHTML={{ __html: visual.svgMarkup! }}
            />
          ) : (
            <div className="visual-fallback-box">
              <p className="visual-fallback-note">{visual.metaphor || visual.title}</p>
            </div>
          )}
        </div>

        {/* Crisp structured legend beneath raster artwork (vector SVGs already embed cards) */}
        {hasRaster && visual.elements && visual.elements.length > 0 && (
          <div className="concept-legend">
            {visual.elements.map((el, idx) => (
              <div key={`${el.label}-${idx}`} className="concept-legend-item">
                <span className={`concept-legend-dot tone-${idx % 4}`} />
                <div className="concept-legend-copy">
                  <span className="concept-legend-label">{el.label}</span>
                  <span className="concept-legend-role">{el.role}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {(visual.caption || visual.metaphor) && (
          <figcaption className="visual-card-caption">
            {visual.caption || visual.metaphor}
          </figcaption>
        )}
      </figure>

      {expanded && (hasRaster || hasSvg) && (
        <VisualLightbox
          title={visual.title}
          badge={badgeLabel}
          badgeClass={badgeClass}
          caption={visual.caption || visual.metaphor}
          canvasStyle="concept"
          onDownloadSecondary={
            hasSvg && !hasRaster ? () => downloadSvgMarkup(visual.svgMarkup!, visual.title) : undefined
          }
          downloadSecondaryLabel="SVG"
          onDownloadPrimary={
            hasRaster
              ? () => downloadDataUrl(visual.imageDataUrl!, visual.title, 'png')
              : hasSvg
                ? () => void downloadSvgAsPng(visual.svgMarkup!, visual.title)
                : undefined
          }
          downloadPrimaryLabel="PNG"
          onClose={() => setExpanded(false)}
        >
          {hasRaster ? (
            <img
              src={visual.imageDataUrl}
              alt={visual.title}
              className="lightbox-raster-img"
              draggable={false}
            />
          ) : lightboxSvg ? (
            <div
              className="lightbox-svg-inner concept-lightbox-svg"
              dangerouslySetInnerHTML={{ __html: lightboxSvg }}
            />
          ) : null}
        </VisualLightbox>
      )}
    </>
  );
}
