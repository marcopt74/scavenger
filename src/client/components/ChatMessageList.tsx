import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ONBOARDING_STAGES } from '../../shared/types';
import type { ChatMessage, CodePeekTarget, ToolActivity, VisualArtifact } from '../../shared/types';
import { ConceptVisualCard } from './ConceptVisualCard';
import { DiagramCard } from './DiagramCard';
import { LessonFooter } from './LessonFooter';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolActivityPill } from './ToolActivityPill';

export const SCROLL_BOTTOM_THRESHOLD_PX = 24;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function hasUnseenContentBelow(
  metrics: ScrollMetrics,
  thresholdPx: number = SCROLL_BOTTOM_THRESHOLD_PX
): boolean {
  if (metrics.scrollHeight <= 0 || metrics.clientHeight <= 0) {
    return false;
  }
  const distanceFromBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distanceFromBottom > thresholdPx;
}

interface ChatMessageListProps {
  messages: ChatMessage[];
  activeTopicTitle: string;
  streamingText: string;
  streamingActivities: ToolActivity[];
  streamingVisuals: VisualArtifact[];
  isStreaming: boolean;
  onSelectPrompt: (prompt: string) => void;
  onOpenCodePeek?: (target: CodePeekTarget) => void;
  knownFiles?: string[];
  initialHasMoreBelow?: boolean;
}

export function ChatMessageList({
  messages,
  activeTopicTitle,
  streamingText,
  streamingActivities,
  streamingVisuals,
  isStreaming,
  onSelectPrompt,
  onOpenCodePeek,
  knownFiles,
  initialHasMoreBelow = false,
}: ChatMessageListProps) {
  const scrollContainerRef = useRef<HTMLElement>(null);
  const streamContentRef = useRef<HTMLDivElement>(null);
  const [hasMoreBelow, setHasMoreBelow] = useState<boolean>(initialHasMoreBelow);

  const updateScrollCue = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setHasMoreBelow(
      hasUnseenContentBelow({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      })
    );
  }, []);

  useEffect(() => {
    updateScrollCue();
  }, [
    updateScrollCue,
    messages.length,
    streamingText,
    streamingVisuals.length,
    streamingActivities.length,
    isStreaming,
  ]);

  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    const streamEl = streamContentRef.current;
    if (!scrollEl) return;

    updateScrollCue();
    window.addEventListener('resize', updateScrollCue);

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        updateScrollCue();
      });
      observer.observe(scrollEl);
      if (streamEl) {
        observer.observe(streamEl);
      }
      return () => {
        observer.disconnect();
        window.removeEventListener('resize', updateScrollCue);
      };
    }

    return () => {
      window.removeEventListener('resize', updateScrollCue);
    };
  }, [updateScrollCue]);

  const handleScrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  return (
    <div className="chat-scroll-region">
      <main
        ref={scrollContainerRef}
        className="chat-scroll"
        onScroll={updateScrollCue}
      >
        <div ref={streamContentRef} className="chat-stream">
          {messages.map((msg, idx) => {
            const isLatestAssistant =
              msg.role === 'assistant' && idx === messages.length - 1 && !isStreaming;
            const label = msg.topicTitle || ONBOARDING_STAGES[msg.stage]?.title || 'Lesson';

            return (
              <div key={msg.id} className={`msg-row ${msg.role}`}>
                {msg.role === 'user' ? (
                  <div className="user-bubble">{msg.content}</div>
                ) : (
                  <article className="assistant-turn">
                    <div className="assistant-header">
                      <span className="assistant-avatar">S</span>
                      <span>{label}</span>
                    </div>

                    {msg.toolActivities && msg.toolActivities.length > 0 && (
                      <ToolActivityPill
                        activities={msg.toolActivities}
                        onOpenCodePeek={onOpenCodePeek}
                      />
                    )}

                    {msg.visuals && msg.visuals.length > 0 && (
                      <VisualStack visuals={msg.visuals} />
                    )}

                    <MarkdownRenderer
                      content={msg.content}
                      onOpenCodePeek={onOpenCodePeek}
                      knownFiles={knownFiles}
                    />

                    <LessonFooter
                      checkInQuestions={msg.checkInQuestions}
                      suggestedNextSteps={msg.suggestedNextSteps}
                      isLatest={isLatestAssistant}
                      disabled={isStreaming}
                      onSelectStep={onSelectPrompt}
                    />
                  </article>
                )}
              </div>
            );
          })}

          {isStreaming && (
            <div className="msg-row assistant">
              <article className="assistant-turn">
                <div className="assistant-header">
                  <span className="assistant-avatar">S</span>
                  <span>{activeTopicTitle || 'Analyzing repository…'}</span>
                </div>

                {streamingActivities.length > 0 && (
                  <ToolActivityPill
                    activities={streamingActivities}
                    onOpenCodePeek={onOpenCodePeek}
                  />
                )}

                {streamingVisuals.length > 0 && (
                  <VisualStack visuals={streamingVisuals} />
                )}

                {streamingText ? (
                  <MarkdownRenderer
                    content={streamingText}
                    isStreaming
                    onOpenCodePeek={onOpenCodePeek}
                    knownFiles={knownFiles}
                  />
                ) : (
                  <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>
                    Preparing grounded response<span className="streaming-cursor" />
                  </div>
                )}
              </article>
            </div>
          )}
        </div>
      </main>

      {hasMoreBelow && (
        <div className="scroll-down-cue-anchor">
          <button
            type="button"
            className={`scroll-down-cue${isStreaming ? ' is-streaming' : ''}`}
            onClick={handleScrollToBottom}
            aria-label={
              isStreaming
                ? 'New output below — scroll down to view'
                : 'More content below — scroll down to view'
            }
            title="Scroll to bottom"
          >
            <ArrowDown size={16} className="scroll-down-cue-icon" aria-hidden="true" />
            <span className="scroll-down-cue-label">
              {isStreaming ? 'New output below' : 'More content below'}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function VisualStack({ visuals }: { visuals: VisualArtifact[] }) {
  return (
    <div className="visuals-stack">
      {visuals.map((visual) => {
        if (visual.kind === 'mermaid') {
          return (
            <DiagramCard
              key={visual.id}
              format="mermaid"
              title={visual.title}
              caption={visual.caption}
              source={visual.source}
            />
          );
        }
        if (visual.kind === 'd2') {
          return (
            <DiagramCard
              key={visual.id}
              format="d2"
              title={visual.title}
              caption={visual.caption}
              source={visual.source}
              preRenderedSvg={visual.svgMarkup}
              preRenderError={visual.renderError}
            />
          );
        }
        return <ConceptVisualCard key={visual.id} visual={visual} />;
      })}
    </div>
  );
}
