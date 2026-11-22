import { Download, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface VisualLightboxProps {
  title: string;
  badge: string;
  badgeClass?: string;
  caption?: string;
  canvasStyle?: 'diagram' | 'concept';
  onDownloadPrimary?: () => void;
  downloadPrimaryLabel?: string;
  onDownloadSecondary?: () => void;
  downloadSecondaryLabel?: string;
  onClose: () => void;
  children: ReactNode;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.75;
const ZOOM_STEP = 0.25;

export function VisualLightbox({
  title,
  badge,
  badgeClass,
  caption,
  canvasStyle = 'diagram',
  onDownloadPrimary,
  downloadPrimaryLabel = 'PNG',
  onDownloadSecondary,
  downloadSecondaryLabel = 'SVG',
  onClose,
  children,
}: VisualLightboxProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragOriginRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const backdropMouseDownRef = useRef(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        setZoom((z) => Math.min(MAX_ZOOM, Number((z + ZOOM_STEP).toFixed(2))));
      } else if (e.key === '-') {
        e.preventDefault();
        setZoom((z) => Math.max(MIN_ZOOM, Number((z - ZOOM_STEP).toFixed(2))));
      } else if (e.key === '0') {
        e.preventDefault();
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  function handleReset() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  function handleWheel(e: React.WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.15 : -0.15;
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((z + delta).toFixed(2)))));
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    setDragging(true);
    dragOriginRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragging || !dragOriginRef.current) return;
    const dx = e.clientX - dragOriginRef.current.x;
    const dy = e.clientY - dragOriginRef.current.y;
    setPan({ x: dragOriginRef.current.panX + dx, y: dragOriginRef.current.panY + dy });
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (!dragging) return;
    setDragging(false);
    dragOriginRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore if pointer capture already released
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        backdropMouseDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropMouseDownRef.current) {
          onClose();
        }
        backdropMouseDownRef.current = false;
      }}
    >
      <div
        className="lightbox-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header lightbox-header">
          <div className="visual-card-title-group">
            <span className={`visual-kind-badge ${badgeClass ?? ''}`}>{badge}</span>
            <h3 className="lightbox-title">{title}</h3>
          </div>

          <div className="lightbox-toolbar">
            <div className="lightbox-zoom-group" aria-label="Zoom controls">
              <button
                type="button"
                className="lightbox-tool-btn"
                onClick={() => setZoom((z) => Math.max(MIN_ZOOM, Number((z - ZOOM_STEP).toFixed(2))))}
                disabled={zoom <= MIN_ZOOM}
                title="Zoom out (-)"
                aria-label="Zoom out"
              >
                <ZoomOut size={15} />
              </button>
              <span className="lightbox-zoom-label">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                className="lightbox-tool-btn"
                onClick={() => setZoom((z) => Math.min(MAX_ZOOM, Number((z + ZOOM_STEP).toFixed(2))))}
                disabled={zoom >= MAX_ZOOM}
                title="Zoom in (+)"
                aria-label="Zoom in"
              >
                <ZoomIn size={15} />
              </button>
              <button
                type="button"
                className="lightbox-tool-btn"
                onClick={handleReset}
                disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
                title="Reset view (0)"
                aria-label="Reset zoom and position"
              >
                <RotateCcw size={14} />
              </button>
            </div>

            {onDownloadSecondary && (
              <button
                type="button"
                className="visual-action-btn"
                onClick={onDownloadSecondary}
                title={`Download ${downloadSecondaryLabel}`}
              >
                <Download size={14} />
                <span>{downloadSecondaryLabel}</span>
              </button>
            )}

            {onDownloadPrimary && (
              <button
                type="button"
                className="visual-action-btn"
                onClick={onDownloadPrimary}
                title={`Download ${downloadPrimaryLabel}`}
              >
                <Download size={14} />
                <span>{downloadPrimaryLabel}</span>
              </button>
            )}

            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label="Close expanded view"
              title="Close (Esc)"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div
          className={`lightbox-body ${canvasStyle === 'diagram' ? 'diagram-canvas' : 'concept-stage'} ${
            dragging ? 'is-dragging' : ''
          }`}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div
            className="lightbox-transform-stage"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
          >
            {children}
          </div>
        </div>

        <div className="lightbox-footer">
          <span className="lightbox-caption">{caption || 'Drag to pan · Ctrl/⌘ + scroll or +/- to zoom · Esc to close'}</span>
          <span className="lightbox-hint">Drag to pan · Esc to close</span>
        </div>
      </div>
    </div>
  );
}
