import { describe, expect, it } from 'vitest';
import {
  buildFallbackConceptSvg,
  generateConceptVisual,
  renderD2ToSvg,
} from '../src/server/tools/visualTools.js';

describe('visualTools (D2 graceful degradation & concept visual fallback)', () => {
  it('builds a clean self-contained fallback SVG concept illustration card', () => {
    const svg = buildFallbackConceptSvg({
      title: 'Request Pipeline Mental Model',
      metaphor: 'Like an airport security checkpoint before reaching the terminal gates.',
      elements: [
        { label: 'Guardrails', role: 'Validate paths & git flags' },
        { label: 'Orchestrator', role: 'Stages & LLM tool loop' },
        { label: 'Chat UI', role: 'Minimalist SVG prose view' },
      ],
    });

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Request Pipeline Mental Model');
    expect(svg).toContain('Guardrails');
    expect(svg).toContain('</svg>');
  });

  it('gracefully falls back to vector concept card when image generation is disabled', async () => {
    const previous = process.env.IMAGE_GEN_ENABLED;
    process.env.IMAGE_GEN_ENABLED = 'false';

    try {
      const artifact = await generateConceptVisual({
        title: 'Layered Architecture',
        metaphor: 'Clean separation between UI, API routes, and read-only tools.',
      });

      expect(artifact.kind).toBe('concept-image');
      if (artifact.kind === 'concept-image') {
        expect(artifact.isFallback).toBe(true);
        expect(artifact.svgMarkup).toContain('<svg');
      }
    } finally {
      if (previous === undefined) delete process.env.IMAGE_GEN_ENABLED;
      else process.env.IMAGE_GEN_ENABLED = previous;
    }
  });

  it('returns structured result instead of throwing when D2 is rendered', async () => {
    const result = await renderD2ToSvg('a -> b: calls');
    expect(typeof result.ok).toBe('boolean');
    if (result.ok) {
      expect(result.svg).toContain('<svg');
    } else {
      expect(result.error).toBeTruthy();
    }
  });
});
