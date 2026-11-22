import { ArrowUp } from 'lucide-react';
import { useRef, useState } from 'react';
import { ONBOARDING_STAGES } from '../../shared/types';
import type { OnboardingStage, ProviderSelection } from '../../shared/types';

interface ComposerProps {
  currentStage: OnboardingStage;
  provider: ProviderSelection;
  observedFilesCount: number;
  observedCommitsCount: number;
  disabled: boolean;
  onSend: (text: string) => void;
}

export function Composer({
  currentStage,
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

  const nextStage = currentStage < 4 ? ONBOARDING_STAGES[currentStage + 1] : null;
  const nudges: Array<{ label: string; prompt: string }> =
    currentStage === 0
      ? [
          {
            label: 'New to stack · High-level orientation',
            prompt: 'I am fairly new to this stack. My goal is high-level orientation, and I prefer conceptual mental models first.',
          },
          {
            label: 'Intermediate · Adding a feature',
            prompt: 'I have intermediate experience with this stack. I want to understand the architecture so I can add a new feature.',
          },
          {
            label: 'Senior · Architecture & internals',
            prompt: 'I am a senior engineer comfortable with this stack. Give me concise architecture, invariants, and trade-offs.',
          },
        ]
      : [
          ...(nextStage
            ? [
                {
                  label: `Next: Stage ${nextStage.id} (${nextStage.shortLabel})`,
                  prompt: `Let's continue to Stage ${nextStage.id}: ${nextStage.title}.`,
                },
              ]
            : []),
          { label: 'Explain simpler', prompt: 'Can you explain that a bit simpler with less jargon?' },
          { label: 'Go deeper', prompt: 'Can we go deeper on the implementation details and trade-offs?' },
        ];

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
            placeholder={
              currentStage === 0
                ? 'Share your experience, goal, and preferred depth…'
                : 'Ask about this repository, request a diagram, or move to the next stage…'
            }
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
