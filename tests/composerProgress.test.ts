import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Composer, deriveComposerProgressCue } from '../src/client/components/Composer.js';
import type { DiagnosticProfile, ProviderSelection, ToolActivity, VisualArtifact } from '../src/shared/types.js';

const baseDiagnostic: DiagnosticProfile = {
  inferredLevel: 'intermediate',
  completed: true,
};

const baseProvider: ProviderSelection = {
  provider: 'copilot',
  model: 'gpt-4.1',
};

describe('Composer visual cue while waiting for model response', () => {
  it('renders idle state without working indicators when not waiting on the model', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        diagnostic: baseDiagnostic,
        activeTopicTitle: 'System Architecture',
        hasPendingCheckIn: false,
        provider: baseProvider,
        observedFilesCount: 5,
        observedCommitsCount: 2,
        disabled: false,
        onSend: () => {},
      })
    );

    expect(html).toContain('class="composer-box"');
    expect(html).not.toContain('is-working');
    expect(html).not.toContain('composer-progress-track');
    expect(html).not.toContain('composer-working-dots');
    expect(html).toContain('aria-label="Send message"');
  });

  it('renders progress bar, animated dots, phase status pill, and spinner inside the bottom textbox when waiting for model response', () => {
    const activities: ToolActivity[] = [
      {
        id: 'act_1',
        toolName: 'read_file',
        summary: 'Reading src/server/agent/orchestrator.ts',
        status: 'running',
      },
    ];

    const html = renderToStaticMarkup(
      createElement(Composer, {
        diagnostic: baseDiagnostic,
        activeTopicTitle: 'System Architecture',
        hasPendingCheckIn: false,
        provider: baseProvider,
        observedFilesCount: 5,
        observedCommitsCount: 2,
        disabled: true,
        streamingText: '',
        streamingActivities: activities,
        streamingVisuals: [],
        onSend: () => {},
      })
    );

    expect(html).toContain('class="composer-box is-working"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="composer-progress-track"');
    expect(html).toContain('class="composer-working-dots"');
    expect(html).toContain('class="composer-working-status"');
    expect(html).toContain('Inspecting repo');
    expect(html).toContain('1 step');
    expect(html).toContain('placeholder="Reading src/server/agent/orchestrator.ts"');
    expect(html).toContain('class="send-btn is-working"');
    expect(html).toContain('aria-label="Waiting for model response"');
    expect(html).toContain('spin-icon');
  });

  it('derives accurate progress cues across Thinking, tool execution, Synthesizing, and Generating phases', () => {
    const thinking = deriveComposerProgressCue({
      activeTopicTitle: 'Core Flows & Implementation',
      streamingText: '',
      streamingActivities: [],
      streamingVisuals: [],
    });
    expect(thinking.phaseLabel).toBe('Thinking');
    expect(thinking.message).toContain('Waiting for model response · Core Flows & Implementation');
    expect(thinking.stepCount).toBe(0);

    const gitInspect = deriveComposerProgressCue({
      activeTopicTitle: 'Git Evolution',
      streamingText: '',
      streamingActivities: [
        {
          id: 'act_git',
          toolName: 'git_inspect',
          summary: 'Inspecting recent commit history',
          status: 'running',
        },
      ],
      streamingVisuals: [],
    });
    expect(gitInspect.phaseLabel).toBe('Checking git');
    expect(gitInspect.message).toBe('Inspecting recent commit history');
    expect(gitInspect.stepCount).toBe(1);

    const synthesizing = deriveComposerProgressCue({
      activeTopicTitle: 'System Architecture',
      streamingText: '',
      streamingActivities: [
        {
          id: 'act_1',
          toolName: 'read_file',
          summary: 'Read src/server/index.ts',
          status: 'completed',
        },
      ],
      streamingVisuals: [
        {
          id: 'vis_1',
          kind: 'mermaid',
          title: 'Architecture Diagram',
          source: 'graph TD; A-->B;',
        } satisfies VisualArtifact,
      ],
    });
    expect(synthesizing.phaseLabel).toBe('Synthesizing');
    expect(synthesizing.message).toContain('1 tool step · 1 visual completed');
    expect(synthesizing.stepCount).toBe(2);

    const generating = deriveComposerProgressCue({
      activeTopicTitle: 'System Architecture',
      streamingText: 'Here is how the modules connect...',
      streamingActivities: [
        {
          id: 'act_1',
          toolName: 'read_file',
          summary: 'Read src/server/index.ts',
          status: 'completed',
        },
      ],
      streamingVisuals: [],
    });
    expect(generating.phaseLabel).toBe('Generating');
    expect(generating.message).toBe('Generating response · System Architecture…');
    expect(generating.stepCount).toBe(1);
  });
});
