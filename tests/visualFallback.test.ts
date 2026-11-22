import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resetSettingsCache } from '../src/server/settingsStore.js';
import {
  buildFallbackConceptSvg,
  generateConceptVisual,
  renderD2ToSvg,
  wrapSvgText,
} from '../src/server/tools/visualTools.js';

describe('visualTools (D2 graceful degradation & editorial concept visuals)', () => {
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

  it('supports pipeline, hub, and layers layouts with distinct compositions and accents', () => {
    const elements = [
      { label: 'Root Config', role: 'Defines build scripts and compiler contracts' },
      { label: 'Core Engine', role: 'Coordinates domain logic and read-only tools' },
      { label: 'Client Surface', role: 'Streams interactive prose and live diagrams' },
    ];

    const pipelineSvg = buildFallbackConceptSvg({
      title: 'Pipeline Flow',
      metaphor: 'Step-by-step data flow through clean boundaries.',
      layout: 'pipeline',
      accent: 'cobalt',
      elements,
    });
    expect(pipelineSvg).toContain('MENTAL MODEL · FLOW');
    expect(pipelineSvg).toContain('01');
    expect(pipelineSvg).toContain('Core Engine');

    const hubSvg = buildFallbackConceptSvg({
      title: 'Orchestrator Hub',
      metaphor: 'Central coordinator routing work to specialists.',
      layout: 'hub',
      accent: 'violet',
      elements,
    });
    expect(hubSvg).toContain('MENTAL MODEL · SYSTEM HUB');
    expect(hubSvg).toContain('CORE ANCHOR');
    expect(hubSvg).toContain('Client Surface');

    const layersSvg = buildFallbackConceptSvg({
      title: 'Architectural Strata',
      metaphor: 'Stacked boundaries separating contracts from UI.',
      layout: 'layers',
      accent: 'emerald',
      elements,
    });
    expect(layersSvg).toContain('MENTAL MODEL · LAYERS');
    expect(layersSvg).toContain('LAYER 01');
    expect(layersSvg).toContain('LAYER 03');
  });

  it('wraps text cleanly on word boundaries without slicing mid-word and escapes XML', () => {
    const lines = wrapSvgText('Validates canonical paths and prevents symlink escapes', 24, 3);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((line) => line.length <= 24)).toBe(true);
    expect(lines.join(' ')).toContain('canonical');
    expect(lines.join(' ')).toContain('symlink');

    const svg = buildFallbackConceptSvg({
      title: 'Input <Raw> & "Safe" Output',
      metaphor: 'Checks <untrusted> paths & preserves invariants.',
      elements: [
        { label: 'Entry <Gate>', role: 'Validates & normalizes requests cleanly' },
        { label: 'Core Engine', role: 'Produces predictable JSON & SSE output' },
      ],
    });
    expect(svg).toContain('Input &lt;Raw&gt; &amp; &quot;Safe&quot; Output');
    expect(svg).toContain('Entry &lt;Gate&gt;');
  });

  it('uses unique SVG <defs> IDs per render so multiple inline concept SVGs never collide', () => {
    const svgA = buildFallbackConceptSvg({
      title: 'First Concept',
      metaphor: 'First metaphor.',
    });
    const svgB = buildFallbackConceptSvg({
      title: 'Second Concept',
      metaphor: 'Second metaphor.',
    });

    const idA = svgA.match(/id="bgGrad-([a-f0-9]+)"/)?.[1];
    const idB = svgB.match(/id="bgGrad-([a-f0-9]+)"/)?.[1];
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  });

  it('gracefully falls back to vector concept card and preserves layout/element metadata when image generation is disabled', async () => {
    const previous = process.env.IMAGE_GEN_ENABLED;
    const previousCfg = process.env.SCAVENGER_CONFIG_PATH;
    process.env.SCAVENGER_CONFIG_PATH = path.join(os.tmpdir(), `scavenger-nonexistent-${Date.now()}.json`);
    process.env.IMAGE_GEN_ENABLED = 'false';
    resetSettingsCache();

    try {
      const artifact = await generateConceptVisual({
        title: 'Layered Architecture',
        metaphor: 'Clean separation between UI, API routes, and read-only tools.',
        layout: 'layers',
        accent: 'emerald',
        elements: [
          { label: 'UI Layer', role: 'Renders lessons & interactive diagrams' },
          { label: 'API Layer', role: 'Validates sessions & streams SSE' },
        ],
      });

      expect(artifact.kind).toBe('concept-image');
      if (artifact.kind === 'concept-image') {
        expect(artifact.isFallback).toBe(true);
        expect(artifact.layout).toBe('layers');
        expect(artifact.accent).toBe('emerald');
        expect(artifact.elements?.length).toBe(2);
        expect(artifact.svgMarkup).toContain('<svg');
        expect(artifact.svgMarkup).toContain('LAYER 01');
      }
    } finally {
      if (previous === undefined) delete process.env.IMAGE_GEN_ENABLED;
      else process.env.IMAGE_GEN_ENABLED = previous;
      if (previousCfg === undefined) delete process.env.SCAVENGER_CONFIG_PATH;
      else process.env.SCAVENGER_CONFIG_PATH = previousCfg;
      resetSettingsCache();
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
