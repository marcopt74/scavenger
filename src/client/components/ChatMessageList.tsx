import { useEffect, useRef } from 'react';
import { ONBOARDING_STAGES } from '../../shared/types';
import type { ChatMessage, ToolActivity, VisualArtifact } from '../../shared/types';
import { ConceptVisualCard } from './ConceptVisualCard';
import { DiagramCard } from './DiagramCard';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolActivityPill } from './ToolActivityPill';

interface ChatMessageListProps {
  messages: ChatMessage[];
  streamingText: string;
  streamingActivities: ToolActivity[];
  streamingVisuals: VisualArtifact[];
  isStreaming: boolean;
}

export function ChatMessageList({
  messages,
  streamingText,
  streamingActivities,
  streamingVisuals,
  isStreaming,
}: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, streamingText, streamingVisuals.length, streamingActivities.length]);

  return (
    <main className="chat-scroll">
      <div className="chat-stream">
        {messages.map((msg) => (
          <div key={msg.id} className={`msg-row ${msg.role}`}>
            {msg.role === 'user' ? (
              <div className="user-bubble">{msg.content}</div>
            ) : (
              <article className="assistant-turn">
                <div className="assistant-header">
                  <span className="assistant-avatar">S</span>
                  <span>
                    Stage {msg.stage} · {ONBOARDING_STAGES[msg.stage]?.title}
                  </span>
                </div>

                {msg.toolActivities && msg.toolActivities.length > 0 && (
                  <ToolActivityPill activities={msg.toolActivities} />
                )}

                {msg.visuals && msg.visuals.length > 0 && (
                  <VisualStack visuals={msg.visuals} />
                )}

                <MarkdownRenderer content={msg.content} />
              </article>
            )}
          </div>
        ))}

        {isStreaming && (
          <div className="msg-row assistant">
            <article className="assistant-turn">
              <div className="assistant-header">
                <span className="assistant-avatar">S</span>
                <span>Analyzing repository…</span>
              </div>

              {streamingActivities.length > 0 && (
                <ToolActivityPill activities={streamingActivities} />
              )}

              {streamingVisuals.length > 0 && (
                <VisualStack visuals={streamingVisuals} />
              )}

              {streamingText ? (
                <div className="prose">
                  <MarkdownRenderer content={streamingText} />
                  <span className="streaming-cursor" />
                </div>
              ) : (
                <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>
                  Preparing grounded response<span className="streaming-cursor" />
                </div>
              )}
            </article>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </main>
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
