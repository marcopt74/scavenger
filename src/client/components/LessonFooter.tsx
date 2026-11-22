import { ArrowUpRight, Compass, HelpCircle } from 'lucide-react';
import type { CheckInQuestion, SuggestedNextStep } from '../../shared/types';

interface LessonFooterProps {
  checkInQuestions?: CheckInQuestion[];
  suggestedNextSteps?: SuggestedNextStep[];
  isLatest: boolean;
  disabled: boolean;
  onSelectStep: (prompt: string) => void;
}

const KIND_LABELS: Record<SuggestedNextStep['kind'], string> = {
  deepen: 'Deepen',
  broaden: 'Broaden',
  revisit: 'Revisit',
  explore: 'Explore',
};

export function LessonFooter({
  checkInQuestions,
  suggestedNextSteps,
  isLatest,
  disabled,
  onSelectStep,
}: LessonFooterProps) {
  const hasQuestions = Boolean(checkInQuestions && checkInQuestions.length > 0);
  const hasSteps = Boolean(suggestedNextSteps && suggestedNextSteps.length > 0);

  if (!hasQuestions && !hasSteps) return null;

  // Keep older turns visually calm and compact
  if (!isLatest) {
    const parts: string[] = [];
    if (hasQuestions) {
      parts.push(
        `${checkInQuestions!.length} check-in question${checkInQuestions!.length === 1 ? '' : 's'}`
      );
    }
    if (hasSteps) {
      parts.push(
        `${suggestedNextSteps!.length} suggested next step${suggestedNextSteps!.length === 1 ? '' : 's'}`
      );
    }
    return (
      <details className="lesson-footer-archived">
        <summary>{parts.join(' · ')}</summary>
        <div className="lesson-footer-archived-body">
          {hasQuestions && (
            <ol className="checkin-list compact">
              {checkInQuestions!.map((q) => (
                <li key={q.id}>{q.question}</li>
              ))}
            </ol>
          )}
          {hasSteps && (
            <div className="archived-step-chips">
              {suggestedNextSteps!.map((step) => (
                <button
                  key={step.id}
                  type="button"
                  className="nudge-chip"
                  disabled={disabled}
                  onClick={() => onSelectStep(step.prompt)}
                >
                  {step.title}
                </button>
              ))}
            </div>
          )}
        </div>
      </details>
    );
  }

  return (
    <div className="lesson-footer">
      {hasQuestions && (
        <section className="checkin-card" aria-label="Optional quick check">
          <div className="checkin-header">
            <HelpCircle size={15} className="checkin-icon" />
            <span className="checkin-title">Quick check</span>
            <span className="checkin-subtitle">Optional · reply to calibrate next depth</span>
          </div>
          <ol className="checkin-list">
            {checkInQuestions!.slice(0, 3).map((q) => (
              <li key={q.id} className="checkin-item">
                <span>{q.question}</span>
                {q.focus && <span className="checkin-focus-tag">{q.focus}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {hasSteps && (
        <section className="next-steps-section" aria-label="Suggested next steps">
          <div className="next-steps-header">
            <Compass size={14} />
            <span>Suggested next steps</span>
            <span className="next-steps-hint">or ask to learn any topic below</span>
          </div>
          <div className="suggested-steps-grid">
            {suggestedNextSteps!.slice(0, 3).map((step) => (
              <button
                key={step.id}
                type="button"
                className="next-step-card"
                disabled={disabled}
                onClick={() => onSelectStep(step.prompt)}
              >
                <div className="next-step-top">
                  <span className={`step-kind-badge kind-${step.kind}`}>
                    {KIND_LABELS[step.kind] || 'Explore'}
                  </span>
                  <ArrowUpRight size={14} className="next-step-arrow" />
                </div>
                <div className="next-step-title">{step.title}</div>
                <div className="next-step-rationale">{step.rationale}</div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
