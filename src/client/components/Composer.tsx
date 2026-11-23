import { ArrowUp, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  DiagnosticProfile,
  ProviderSelection,
  ToolActivity,
  VisualArtifact,
} from '../../shared/types';

export interface ComposerProgressCue {
  phaseLabel: string;
  message: string;
  stepCount: number;
}

export function deriveComposerProgressCue(options: {
  activeTopicTitle: string;
  streamingText?: string;
  streamingActivities?: ToolActivity[];
  streamingVisuals?: VisualArtifact[];
}): ComposerProgressCue {
  const activities = options.streamingActivities ?? [];
  const visuals = options.streamingVisuals ?? [];
  const text = options.streamingText ?? '';
  const runningActivity = [...activities].reverse().find((a) => a.status === 'running');
  const stepCount = activities.length + visuals.length;

  if (runningActivity) {
    let phaseLabel = 'Working';
    if (['read_file', 'list_tree', 'grep_search'].includes(runningActivity.toolName)) {
      phaseLabel = 'Inspecting repo';
    } else if (runningActivity.toolName === 'git_inspect') {
      phaseLabel = 'Checking git';
    } else if (
      ['render_mermaid', 'render_d2', 'generate_concept_visual'].includes(runningActivity.toolName)
    ) {
      phaseLabel = 'Rendering visual';
    } else if (runningActivity.toolName === 'refresh_knowledge_map') {
      phaseLabel = 'Refreshing map';
    }
    return {
      phaseLabel,
      message: runningActivity.summary || 'Inspecting repository…',
      stepCount,
    };
  }

  if (text.trim().length > 0) {
    return {
      phaseLabel: 'Generating',
      message: options.activeTopicTitle
        ? `Generating response · ${options.activeTopicTitle}…`
        : 'Generating response…',
      stepCount,
    };
  }

  if (stepCount > 0) {
    const parts: string[] = [];
    if (activities.length > 0) {
      parts.push(`${activities.length} tool step${activities.length === 1 ? '' : 's'}`);
    }
    if (visuals.length > 0) {
      parts.push(`${visuals.length} visual${visuals.length === 1 ? '' : 's'}`);
    }
    return {
      phaseLabel: 'Synthesizing',
      message: `Waiting for model response (${parts.join(' · ')} completed)…`,
      stepCount,
    };
  }

  return {
    phaseLabel: 'Thinking',
    message: options.activeTopicTitle
      ? `Waiting for model response · ${options.activeTopicTitle}…`
      : 'Waiting for model response…',
    stepCount: 0,
  };
}

interface ComposerProps {
  diagnostic: DiagnosticProfile;
  activeTopicTitle: string;
  hasPendingCheckIn: boolean;
  provider: ProviderSelection;
  observedFilesCount: number;
  observedCommitsCount: number;
  disabled: boolean;
  streamingText?: string;
  streamingActivities?: ToolActivity[];
  streamingVisuals?: VisualArtifact[];
  onSend: (text: string) => void;
}

export function Composer({
  diagnostic,
  activeTopicTitle,
  hasPendingCheckIn,
  provider,
  observedFilesCount,
  observedCommitsCount,
  disabled,
  streamingText,
  streamingActivities,
  streamingVisuals,
  onSend,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!disabled) {
      setElapsedSeconds(0);
      return;
    }
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    const start = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.max(1, Math.floor((Date.now() - start) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [disabled]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
  }

  const nudges: Array<{ label: string; prompt: string }> = !diagnostic.completed
    ? [
        {
          label: 'New to stack · Mental models first',
          prompt:
            'I am new to this stack. My goal is high-level orientation, and I prefer conceptual mental models first.',
        },
        {
          label: 'Intermediate · Architecture & flows',
          prompt:
            'I have intermediate experience with this stack. I want to understand the architecture and key flows.',
        },
        {
          label: 'Senior · Internals & trade-offs',
          prompt:
            'I am a senior engineer comfortable with this stack. Focus on architecture, invariants, and trade-offs.',
        },
      ]
    : [
        { label: 'Explain simpler', prompt: 'Can you explain that simpler with a clearer mental model?' },
        {
          label: 'Walk through a real example',
          prompt: `Walk me step-by-step through a concrete runtime example of ${activeTopicTitle} over time.`,
        },
        {
          label: "What's subtle or tricky here?",
          prompt: `What are the subtle behaviors, edge cases, or hidden interdependencies in ${activeTopicTitle} that usually trip people up?`,
        },
        { label: 'Go deeper', prompt: 'Go deeper on the internals, code contracts, and trade-offs.' },
      ];

  const idlePlaceholder = !diagnostic.completed
    ? 'Answer the quick calibration — or tell me any topic you want to learn right away…'
    : hasPendingCheckIn
      ? 'Answer the quick check above, click a next step, or ask to learn any topic…'
      : 'Ask to learn any topic, module, or file — or pick a suggested step above…';

  const progressCue = disabled
    ? deriveComposerProgressCue({
        activeTopicTitle,
        streamingText,
        streamingActivities,
        streamingVisuals,
      })
    : null;

  const placeholder = progressCue ? progressCue.message : idlePlaceholder;

  return (
    <div className="composer-dock">
      <div className="composer-inner">
        <div className="nudge-row">
          {nudges.map((nudge) => (
            <button
              key={nudge.label}
              type="button"
              className="nudge-chip"
              disabled={disabled}
              onClick={() => onSend(nudge.prompt)}
            >
              {nudge.label}
            </button>
          ))}
        </div>

        <div className={`composer-box${disabled ? ' is-working' : ''}`} aria-busy={disabled}>
          {disabled && (
            <div
              className="composer-progress-track"
              role="progressbar"
              aria-label="Waiting for model response"
            >
              <div className="composer-progress-bar" />
            </div>
          )}

          {disabled && (
            <div className="composer-working-dots" aria-hidden="true">
              <span className="composer-working-dot" />
              <span className="composer-working-dot" />
              <span className="composer-working-dot" />
            </div>
          )}

          <textarea
            ref={textareaRef}
            className="composer-textarea"
            rows={1}
            value={disabled ? '' : text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={placeholder}
          />

          {disabled && progressCue && (
            <div className="composer-working-status" role="status" aria-live="polite">
              <span className="composer-phase-badge">{progressCue.phaseLabel}</span>
              {progressCue.stepCount > 0 && (
                <span className="composer-step-count">
                  {progressCue.stepCount} {progressCue.stepCount === 1 ? 'step' : 'steps'}
                </span>
              )}
              {elapsedSeconds > 0 && (
                <span className="composer-elapsed">{elapsedSeconds}s</span>
              )}
            </div>
          )}

          <button
            type="button"
            className={`send-btn${disabled ? ' is-working' : ''}`}
            onClick={submit}
            disabled={disabled || !text.trim()}
            aria-label={disabled ? 'Waiting for model response' : 'Send message'}
          >
            {disabled ? <Loader2 size={18} className="spin-icon" /> : <ArrowUp size={18} />}
          </button>
        </div>

        <div className="composer-footnote">
          <span>
            Read-only grounded · {observedFilesCount} path{observedFilesCount === 1 ? '' : 's'}
            {observedCommitsCount > 0 ? ` · ${observedCommitsCount} git refs` : ''}
          </span>
          <span>
            {provider.provider === 'demo'
              ? 'Demo Mode (zero-key local grounding)'
              : `${provider.provider} · ${provider.model || 'default'}`}
          </span>
        </div>
      </div>
    </div>
  );
}
