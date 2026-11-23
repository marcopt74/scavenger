import { FileCode, GitCommitHorizontal } from 'lucide-react';
import { createContext, useContext } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CodePeekTarget } from '../../shared/types';
import { parseCodeCitation } from '../utils/citationParser';
import { remarkHighlighter } from '../utils/highlightMarkdown';
import { DiagramCard } from './DiagramCard';

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
  onOpenCodePeek?: (target: CodePeekTarget) => void;
  knownFiles?: string[];
}

const InsidePreContext = createContext<boolean>(false);

/**
 * Renders Markdown cleanly while intercepting any fenced `mermaid` or `d2` blocks
 * and displaying them visually as SVG DiagramCards rather than raw diagram syntax,
 * rendering `==...==` (plus smart fallback insights) with a realistic yellow highlighter effect,
 * and turning inline file/line/commit citations into clickable Read-Only Code Peek chips.
 */
export function MarkdownRenderer({
  content,
  isStreaming = false,
  onOpenCodePeek,
  knownFiles,
}: MarkdownRendererProps) {
  return (
    <div className={isStreaming ? 'prose is-streaming' : 'prose'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkHighlighter]}
        components={{
          pre({ children }) {
            // Check if the child code element is a mermaid or d2 block
            const child = Array.isArray(children) ? children[0] : children;
            if (
              child &&
              typeof child === 'object' &&
              'props' in child &&
              child.props &&
              typeof child.props === 'object'
            ) {
              const props = child.props as { className?: string; children?: unknown };
              const className = props.className || '';
              const rawCode = String(props.children ?? '').trim();

              if (className.includes('language-mermaid')) {
                return (
                  <div style={{ margin: '14px 0' }}>
                    <DiagramCard
                      format="mermaid"
                      title="Architecture & Flow Diagram"
                      source={rawCode}
                    />
                  </div>
                );
              }
              if (className.includes('language-d2')) {
                return (
                  <div style={{ margin: '14px 0' }}>
                    <DiagramCard
                      format="d2"
                      title="Architecture Diagram"
                      source={rawCode}
                    />
                  </div>
                );
              }
            }
            return (
              <InsidePreContext.Provider value={true}>
                <pre>{children}</pre>
              </InsidePreContext.Provider>
            );
          },
          code({ className, children }) {
            const insidePre = useContext(InsidePreContext);
            const rawText = String(children ?? '');
            const isBlock =
              insidePre ||
              Boolean(className && className.includes('language-')) ||
              rawText.includes('\n');

            if (!isBlock && onOpenCodePeek) {
              const target = parseCodeCitation(rawText, { knownFiles });
              if (target) {
                return (
                  <button
                    type="button"
                    className="inline-citation-chip"
                    onClick={() => onOpenCodePeek(target)}
                    title="Click to peek in Read-Only Inspector"
                  >
                    {target.kind === 'git' ? (
                      <GitCommitHorizontal
                        size={12}
                        className="inline-citation-icon"
                        aria-hidden="true"
                      />
                    ) : (
                      <FileCode
                        size={12}
                        className="inline-citation-icon"
                        aria-hidden="true"
                      />
                    )}
                    <span>{children}</span>
                  </button>
                );
              }
            }

            return <code className={className}>{children}</code>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
