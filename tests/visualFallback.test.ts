import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEffectiveVisualSettings, resetSettingsCache } from '../src/server/settingsStore.js';
import {
  buildFallbackConceptSvg,
  generateConceptVisual,
  renderD2ToSvg,
  sanitizeConceptSvg,
  supportsNativeImageOutput,
  wrapSvgText,
} from '../src/server/tools/visualTools.js';

describe('visualTools (D2 graceful degradation & editorial concept visuals)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetSettingsCache();
  });

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

  it('Tier 1: generates native multimodal raster image directly from active Google Gemini model via :generateContent', async () => {
    const prevKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const prevCfg = process.env.SCAVENGER_CONFIG_PATH;
    process.env.SCAVENGER_CONFIG_PATH = path.join(os.tmpdir(), `scavenger-tier1-gemini-${Date.now()}.json`);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'AIzaSyTestTier1MultimodalKey';
    resetSettingsCache();

    const capturedRequests: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      capturedRequests.push({ url, body });

      if (url.includes(':generateContent')) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'Generated architectural illustration.' },
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Unexpected endpoint', { status: 404 });
    });

    try {
      expect(supportsNativeImageOutput({ provider: 'google', model: 'gemini-2.5-flash' })).toBe(true);
      expect(supportsNativeImageOutput({ provider: 'openai', model: 'gpt-4.1' })).toBe(false);

      const artifact = await generateConceptVisual(
        {
          title: 'Multimodal Hub Concept',
          metaphor: 'Central orchestrator routing events to workers.',
          layout: 'hub',
          accent: 'violet',
          elements: [
            { label: 'Core Router', role: 'Dispatches incoming tasks' },
            { label: 'Worker Pool', role: 'Executes bounded jobs' },
          ],
        },
        { provider: 'google', model: 'gemini-2.5-flash' }
      );

      expect(capturedRequests.length).toBe(1);
      expect(capturedRequests[0].url).toContain('models/gemini-2.5-flash:generateContent');
      expect(capturedRequests[0].body).toMatchObject({
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
        },
      });

      expect(artifact.kind).toBe('concept-image');
      if (artifact.kind === 'concept-image') {
        expect(artifact.isFallback).toBe(false);
        expect(artifact.imageDataUrl).toContain('data:image/png;base64,iVBORw0KGgo');
        expect(artifact.svgMarkup).toBeUndefined();
      }
    } finally {
      if (prevKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = prevKey;
      if (prevCfg === undefined) delete process.env.SCAVENGER_CONFIG_PATH;
      else process.env.SCAVENGER_CONFIG_PATH = prevCfg;
      resetSettingsCache();
    }
  });

  it('Tier 2: generates bespoke <svg viewBox="0 0 880 420"> via active chat LLM and sanitizes <script> and on* attributes', async () => {
    const prevCfg = process.env.SCAVENGER_CONFIG_PATH;
    const prevBase = process.env.OPENAI_COMPATIBLE_BASE_URL;
    const prevGoogle = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const prevGemini = process.env.GEMINI_API_KEY;
    const prevOpenAi = process.env.OPENAI_API_KEY;

    process.env.SCAVENGER_CONFIG_PATH = path.join(os.tmpdir(), `scavenger-tier2-svg-${Date.now()}.json`);
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:11434/v1';
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    resetSettingsCache();

    // Direct unit check on sanitizeConceptSvg
    const dirtySvg = [
      '```xml',
      '<svg onload="alert(1)" onmouseover=\'steal()\'>',
      '  <script>window.pwned = true;</script>',
      '  <foreignObject><div>bad</div></foreignObject>',
      '  <rect x="10" y="10" width="200" height="80" fill="#EFF6FF" onclick="evil()" />',
      '  <a href="javascript:alert(2)"><text x="24" y="48">Guardrail Gate</text></a>',
      '</svg>',
      '```',
    ].join('\n');

    const cleaned = sanitizeConceptSvg(dirtySvg);
    expect(cleaned).toBeTruthy();
    expect(cleaned).toContain('viewBox="0 0 880 420"');
    expect(cleaned).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(cleaned).toContain('Guardrail Gate');
    expect(cleaned).not.toContain('<script');
    expect(cleaned).not.toContain('<foreignObject');
    expect(cleaned).not.toContain('onload');
    expect(cleaned).not.toContain('onmouseover');
    expect(cleaned).not.toContain('onclick');
    expect(cleaned).not.toContain('javascript:');

    // End-to-end Tier 2 check through generateConceptVisual with an active non-image LLM provider
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-svg-test',
            object: 'chat.completion',
            created: 1700000000,
            model: 'qwen2.5-coder:14b',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content:
                    '<svg viewBox="0 0 880 420" onload="hack()"><script>evil()</script><rect width="880" height="420" rx="16" fill="#F8FAFC" onclick="bad()"/><text x="48" y="72">Bespoke Active Model Concept</text></svg>',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    try {
      expect(getEffectiveVisualSettings().imageGenAvailable).toBe(true);

      const artifact = await generateConceptVisual(
        {
          title: 'Bespoke Active Model Concept',
          metaphor: 'Tailored vector architecture synthesized by the session chat model.',
          layout: 'pipeline',
          accent: 'cobalt',
          elements: [
            { label: 'Ingress', role: 'Normalizes request payload' },
            { label: 'Core', role: 'Applies domain invariants' },
          ],
        },
        {
          provider: 'openai-compatible',
          model: 'qwen2.5-coder:14b',
          baseUrl: 'http://localhost:11434/v1',
        }
      );

      expect(artifact.kind).toBe('concept-image');
      if (artifact.kind === 'concept-image') {
        expect(artifact.isFallback).toBe(false);
        expect(artifact.svgMarkup).toContain('viewBox="0 0 880 420"');
        expect(artifact.svgMarkup).toContain('Bespoke Active Model Concept');
        expect(artifact.svgMarkup).not.toContain('<script');
        expect(artifact.svgMarkup).not.toContain('onload');
        expect(artifact.svgMarkup).not.toContain('onclick');
      }
    } finally {
      if (prevCfg === undefined) delete process.env.SCAVENGER_CONFIG_PATH;
      else process.env.SCAVENGER_CONFIG_PATH = prevCfg;
      if (prevBase === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL;
      else process.env.OPENAI_COMPATIBLE_BASE_URL = prevBase;
      if (prevGoogle !== undefined) process.env.GOOGLE_GENERATIVE_AI_API_KEY = prevGoogle;
      if (prevGemini !== undefined) process.env.GEMINI_API_KEY = prevGemini;
      if (prevOpenAi !== undefined) process.env.OPENAI_API_KEY = prevOpenAi;
      resetSettingsCache();
    }
  });

  it('Tier 3: falls back cleanly to deterministic buildFallbackConceptSvg in demo mode or when model generation fails', async () => {
    const prevCfg = process.env.SCAVENGER_CONFIG_PATH;
    const prevBase = process.env.OPENAI_COMPATIBLE_BASE_URL;
    process.env.SCAVENGER_CONFIG_PATH = path.join(os.tmpdir(), `scavenger-tier3-fallback-${Date.now()}.json`);
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:11434/v1';
    resetSettingsCache();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));

    try {
      // 1. Demo mode skips all network calls and uses deterministic fallback SVG
      const demoArtifact = await generateConceptVisual(
        {
          title: 'Demo Mode Offline Concept',
          metaphor: 'Deterministic offline concept visual.',
          layout: 'hub',
          accent: 'amber',
        },
        { provider: 'demo', model: 'local-grounded-demo' }
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(demoArtifact.kind).toBe('concept-image');
      if (demoArtifact.kind === 'concept-image') {
        expect(demoArtifact.isFallback).toBe(true);
        expect(demoArtifact.svgMarkup).toContain('Demo Mode Offline Concept');
        expect(demoArtifact.svgMarkup).toContain('MENTAL MODEL · SYSTEM HUB');
      }

      // 2. Active provider network failure degrades gracefully to Tier 3 deterministic SVG
      const failedModelArtifact = await generateConceptVisual(
        {
          title: 'Resilient Offline Fallback',
          metaphor: 'Gracefully recovers when the active LLM endpoint errors out.',
          layout: 'pipeline',
          accent: 'emerald',
        },
        {
          provider: 'openai-compatible',
          model: 'llama3.2',
          baseUrl: 'http://localhost:11434/v1',
        }
      );

      expect(fetchSpy).toHaveBeenCalled();
      expect(failedModelArtifact.kind).toBe('concept-image');
      if (failedModelArtifact.kind === 'concept-image') {
        expect(failedModelArtifact.isFallback).toBe(true);
        expect(failedModelArtifact.svgMarkup).toContain('Resilient Offline Fallback');
        expect(failedModelArtifact.svgMarkup).toContain('MENTAL MODEL · FLOW');
      }
    } finally {
      if (prevCfg === undefined) delete process.env.SCAVENGER_CONFIG_PATH;
      else process.env.SCAVENGER_CONFIG_PATH = prevCfg;
      if (prevBase === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL;
      else process.env.OPENAI_COMPATIBLE_BASE_URL = prevBase;
      resetSettingsCache();
    }
  });
});
