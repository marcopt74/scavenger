import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { MarkdownRenderer } from '../src/client/components/MarkdownRenderer.js';

describe('MarkdownRenderer yellow highlighter effect (remarkHighlighter)', () => {
  it('renders ==important idea== markers as <mark class="highlighter-mark"> with stroke variants', () => {
    const markdown = [
      'When onboarding onto a codebase, ==validate inputs at the outermost boundary== so downstream modules stay simple.',
      '',
      'Second paragraph with ==another core architectural invariant==.',
    ].join('\n');

    const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content: markdown }));

    expect(html).toContain('<mark class="highlighter-mark highlighter-variant-1">validate inputs at the outermost boundary</mark>');
    expect(html).toContain('<mark class="highlighter-mark highlighter-variant-2">another core architectural invariant</mark>');
    expect(html).not.toContain('==');
  });

  it('supports nested inline code and bold inside ==...== highlights across sibling nodes', () => {
    const markdown =
      'Always ==treat `pathGuard.ts` as a **contract boundary**== before touching deeper files.';

    const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content: markdown }));

    expect(html).toContain('<mark class="highlighter-mark highlighter-variant-1">');
    expect(html).toContain('treat <code>pathGuard.ts</code> as a <strong>contract boundary</strong>');
    expect(html).not.toContain('==');
  });

  it('does not corrupt == or === inside fenced code blocks, inline code, or equality expressions', () => {
    const markdown = [
      'In JavaScript, `a == b` and `a === b` compare values, while a == b in plain text with spaces is not a highlight.',
      '',
      '```ts',
      'const isMatch = left == right || left === "==not-a-highlight==";',
      '```',
    ].join('\n');

    const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content: markdown }));

    expect(html).not.toContain('<mark');
    expect(html).toContain('<code>a == b</code>');
    expect(html).toContain('==not-a-highlight==');
  });

  it('renders a trailing unclosed ==phrase cleanly during live SSE streaming', () => {
    const streamingPartial =
      'Notice how root configuration ==actively defines the rules under which downstream modules';

    const html = renderToStaticMarkup(
      createElement(MarkdownRenderer, { content: streamingPartial })
    );

    expect(html).toContain(
      '<mark class="highlighter-mark highlighter-variant-1">actively defines the rules under which downstream modules</mark>'
    );
    expect(html).not.toContain('==');
  });

  it('applies smart fallback highlights to takeaway blockquotes and key conceptual bold phrases when no explicit ==...== exists', () => {
    const unmarkedLesson = [
      '### Understanding System Boundaries',
      '',
      'When exploring a large service, **dependency direction across module boundaries** determines how safely you can refactor internal helpers without breaking callers.',
      '',
      '> **Mental model to keep:** Outer modules handle changing inputs and presentation, while inner modules guard core invariants. Keep that separation clean.',
    ].join('\n');

    const html = renderToStaticMarkup(
      createElement(MarkdownRenderer, { content: unmarkedLesson })
    );

    expect(html).toContain('<mark class="highlighter-mark');
    expect(html).toContain('Outer modules handle changing inputs and presentation, while inner modules guard core invariants.');
    expect(html).toContain('<strong>dependency direction across module boundaries</strong>');
  });

  it('applies single-layer .prose.is-streaming class when streaming without duplicate nested .prose wrappers', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownRenderer, {
        content: 'Streaming live explanation with `inlineCode` and *italic* emphasis',
        isStreaming: true,
      })
    );

    expect(html.startsWith('<div class="prose is-streaming">')).toBe(true);
    expect(html).toContain('<code>inlineCode</code>');
    expect(html).toContain('<em>italic</em>');
  });
});
