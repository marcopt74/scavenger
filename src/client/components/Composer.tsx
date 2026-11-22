import { ArrowUp } from 'lucide-react';
import { useRef, useState } from 'react';
import type { DiagnosticProfile, ProviderSelection } from '../../shared/types';

interface ComposerProps {
  diagnostic: DiagnosticProfile;
  activeTopicTitle: string;
  hasPendingCheckIn: boolean;
  provider: ProviderSelection;
  observedFilesCount: number;
  observedCommitsCount: number;
  disabled: boolean;
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
  onSend,
}: ComposerProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const placeholder = !diagnostic.completed
    ? 'Answer the quick calibration — or tell me any topic you want to learn right away…'
    : hasPendingCheckIn
      ? 'Answer the quick check above, click a next step, or ask to learn any topic…'
      : 'Ask to learn any topic, module, or file — or pick a suggested step above…';

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

        <div className="composer-box">
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            rows={1}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={placeholder}
          />
          <button
            type="button"
            className="send-btn"
            onClick={submit}
            disabled={disabled || !text.trim()}
            aria-label="Send message"
          >
            <ArrowUp size={18} />
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
