import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DiagramCard } from './DiagramCard';

interface MarkdownRendererProps {
  content: string;
}

/**
 * Renders Markdown cleanly while intercepting any fenced `mermaid` or `d2` blocks
 * and displaying them visually as SVG DiagramCards rather than raw diagram syntax.
 */
export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
            return <pre>{children}</pre>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
