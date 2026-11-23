export interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

const STREAMING_TAIL_HIGHLIGHT_RE = /(?<!=)==(?=\S)([^=\n]{2,})$/;

const CALLOUT_LABEL_RE =
  /^(?:mental model to keep|subtle behavior to notice|mentor note|key takeaway|why this matters|core invariant)\s*:?\s*$/i;

function createMarkNode(children: MdastNode[], variantIndex: number): MdastNode {
  const variantClass = `highlighter-variant-${(variantIndex % 3) + 1}`;
  return {
    type: 'highlightMark',
    data: {
      hName: 'mark',
      hProperties: {
        className: ['highlighter-mark', variantClass],
      },
    },
    children,
  };
}

function getPlainText(node: MdastNode): string {
  if (typeof node.value === 'string') return node.value;
  if (!Array.isArray(node.children)) return '';
  return node.children.map(getPlainText).join('');
}

function findNextOpeningDoubleEquals(
  text: string,
  fromIndex: number,
  hasNextInlineSibling: boolean
): number {
  const re = /(?<!=)==(?!=)/g;
  re.lastIndex = fromIndex;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const idx = match.index;
    const afterIdx = idx + 2;
    if (afterIdx < text.length && /\S/.test(text[afterIdx])) {
      return idx;
    }
    if (afterIdx === text.length && hasNextInlineSibling) {
      return idx;
    }
  }
  return -1;
}

function findNextClosingDoubleEquals(
  text: string,
  fromIndex: number,
  allowAtStart: boolean
): number {
  const re = /(?<!=)==(?!=)/g;
  re.lastIndex = fromIndex;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const idx = match.index;
    if (idx === fromIndex && allowAtStart) {
      return idx;
    }
    if (idx > fromIndex && /\S/.test(text[idx - 1])) {
      return idx;
    }
  }
  return -1;
}

/**
 * Unified left-to-right scanner that pairs opening and closing `==` markers
 * both within a single text node and across sibling inline nodes (`inlineCode`, `strong`, etc.).
 */
function scanAndMergeInlineHighlights(
  children: MdastNode[],
  counter: { count: number }
): MdastNode[] {
  const working = children.map((c) => (c.type === 'text' ? { ...c } : c));
  const output: MdastNode[] = [];
  let i = 0;

  while (i < working.length) {
    const child = working[i];
    if (child.type !== 'text' || typeof child.value !== 'string') {
      output.push(child);
      i++;
      continue;
    }

    const text = child.value;
    const hasNextInline = i + 1 < working.length && working[i + 1].type !== 'text';
    const openIdx = findNextOpeningDoubleEquals(text, 0, hasNextInline);

    if (openIdx === -1) {
      if (text.length > 0) output.push(child);
      i++;
      continue;
    }

    // 1. Check if the closing `==` is in the same text node
    const sameNodeCloseIdx = findNextClosingDoubleEquals(text, openIdx + 2, false);
    if (sameNodeCloseIdx !== -1) {
      const before = text.slice(0, openIdx);
      const inner = text.slice(openIdx + 2, sameNodeCloseIdx);
      const after = text.slice(sameNodeCloseIdx + 2);

      if (before) output.push({ type: 'text', value: before });
      output.push(createMarkNode([{ type: 'text', value: inner }], counter.count++));

      if (after) {
        working[i] = { type: 'text', value: after };
        continue;
      } else {
        i++;
        continue;
      }
    }

    // 2. Otherwise search subsequent sibling nodes for the matching closing `==`
    let closeSiblingIdx = -1;
    let closePos = -1;

    for (let j = i + 1; j < working.length; j++) {
      const candidate = working[j];
      if (candidate.type === 'text' && typeof candidate.value === 'string') {
        const prevIsInline = working[j - 1].type !== 'text';
        const foundPos = findNextClosingDoubleEquals(candidate.value, 0, prevIsInline);
        if (foundPos !== -1) {
          closeSiblingIdx = j;
          closePos = foundPos;
          break;
        }
      }
    }

    if (closeSiblingIdx !== -1 && closePos !== -1) {
      const beforeOpen = text.slice(0, openIdx);
      const afterOpen = text.slice(openIdx + 2);
      if (beforeOpen) output.push({ type: 'text', value: beforeOpen });

      const markChildren: MdastNode[] = [];
      if (afterOpen) markChildren.push({ type: 'text', value: afterOpen });

      for (let mid = i + 1; mid < closeSiblingIdx; mid++) {
        markChildren.push(working[mid]);
      }

      const closingText = working[closeSiblingIdx].value ?? '';
      const beforeClose = closingText.slice(0, closePos);
      const afterClose = closingText.slice(closePos + 2);
      if (beforeClose) markChildren.push({ type: 'text', value: beforeClose });

      output.push(createMarkNode(markChildren, counter.count++));

      if (afterClose) {
        working[closeSiblingIdx] = { type: 'text', value: afterClose };
        i = closeSiblingIdx;
        continue;
      } else {
        i = closeSiblingIdx + 1;
        continue;
      }
    }

    // Unmatched `==` (or handled later by streaming tail); emit node as-is
    output.push(child);
    i++;
  }

  return output;
}

/**
 * Recursively transforms explicit `==...==` markers inside the AST while skipping
 * `code`, `inlineCode`, and already-created `highlightMark` nodes.
 */
function transformExplicitHighlights(node: MdastNode, counter: { count: number }): void {
  if (
    node.type === 'code' ||
    node.type === 'inlineCode' ||
    node.type === 'highlightMark' ||
    !Array.isArray(node.children)
  ) {
    return;
  }

  node.children = scanAndMergeInlineHighlights(node.children, counter);

  // Recurse into child containers
  for (const child of node.children) {
    transformExplicitHighlights(child, counter);
  }
}

/**
 * Handles an unclosed trailing `==phrase` at the very end of the AST during live SSE streaming
 * so the user sees the yellow highlighter sweep smoothly without raw `==` characters flashing.
 */
function transformStreamingTailHighlight(root: MdastNode, counter: { count: number }): void {
  if (!Array.isArray(root.children) || root.children.length === 0) return;

  let cursor: MdastNode = root;
  while (Array.isArray(cursor.children) && cursor.children.length > 0) {
    const lastChild = cursor.children[cursor.children.length - 1];
    if (lastChild.type === 'code' || lastChild.type === 'inlineCode' || lastChild.type === 'highlightMark') {
      return;
    }
    if (lastChild.type === 'text' && typeof lastChild.value === 'string') {
      const match = STREAMING_TAIL_HIGHLIGHT_RE.exec(lastChild.value);
      if (!match) return;

      const before = lastChild.value.slice(0, match.index);
      const highlightedTail = match[1];
      const replacement: MdastNode[] = [];
      if (before) {
        replacement.push({ type: 'text', value: before });
      }
      replacement.push(createMarkNode([{ type: 'text', value: highlightedTail }], counter.count++));
      cursor.children.splice(cursor.children.length - 1, 1, ...replacement);
      return;
    }
    cursor = lastChild;
  }
}

/**
 * Smart Fallback:
 * When a substantive lesson message contains no explicit `==...==` markers,
 * selectively highlight:
 * 1. The core insight phrase inside takeaway blockquotes (`> **Mental model to keep:** ...`)
 * 2. Up to 2 high-signal conceptual `**bold**` phrases in body paragraphs (ignoring short label prefixes).
 */
function applySmartFallbackHighlights(root: MdastNode, counter: { count: number }): void {
  if (!Array.isArray(root.children)) return;

  const fullText = getPlainText(root).trim();
  if (fullText.length < 120) return;

  const MAX_FALLBACK_HIGHLIGHTS = 3;

  // 1. Highlight the core takeaway inside blockquotes (e.g., "> **Mental model to keep:** ...")
  for (const block of root.children) {
    if (counter.count >= MAX_FALLBACK_HIGHLIGHTS) break;
    if (block.type !== 'blockquote' || !Array.isArray(block.children)) continue;

    for (const para of block.children) {
      if (para.type !== 'paragraph' || !Array.isArray(para.children) || para.children.length === 0) {
        continue;
      }

      const first = para.children[0];
      const firstText = getPlainText(first).trim();
      const isCalloutPrefix = first.type === 'strong' && CALLOUT_LABEL_RE.test(firstText);

      if (isCalloutPrefix && para.children.length > 1) {
        // Wrap the first sentence / primary clause following the callout label
        const restChildren = para.children.slice(1);
        const wrappedRest = wrapFirstSentenceInMark(restChildren, counter);
        if (wrappedRest) {
          para.children = [first, ...wrappedRest];
          break;
        }
      }
    }
  }

  // 2. Highlight up to 2 meaningful conceptual `strong` phrases in body paragraphs
  for (const block of root.children) {
    if (counter.count >= MAX_FALLBACK_HIGHLIGHTS) break;
    if (block.type !== 'paragraph' || !Array.isArray(block.children)) continue;

    for (let i = 0; i < block.children.length; i++) {
      if (counter.count >= MAX_FALLBACK_HIGHLIGHTS) break;
      const child = block.children[i];
      if (child.type !== 'strong' || !Array.isArray(child.children)) continue;

      const phrase = getPlainText(child).trim();
      const nextSibling = block.children[i + 1];
      const nextText = nextSibling?.type === 'text' ? (nextSibling.value ?? '') : '';

      // Skip short labels, headings/prefixes followed by colons, or single code tokens
      if (
        phrase.length < 10 ||
        phrase.length > 90 ||
        phrase.endsWith(':') ||
        nextText.trimStart().startsWith(':') ||
        CALLOUT_LABEL_RE.test(phrase) ||
        ( child.children.length === 1 && child.children[0].type === 'inlineCode' )
      ) {
        continue;
      }

      block.children[i] = createMarkNode([child], counter.count++);
      // At most 1 fallback bold highlight per paragraph so highlights stay well-spaced
      break;
    }
  }
}

/**
 * Wraps the leading sentence/clause of a blockquote body in a `<mark>` node.
 */
function wrapFirstSentenceInMark(
  nodes: MdastNode[],
  counter: { count: number }
): MdastNode[] | null {
  if (nodes.length === 0) return null;

  const markChildren: MdastNode[] = [];
  const trailingNodes: MdastNode[] = [];
  let initialLeadingSpace = '';
  let finishedFirstSentence = false;
  let accumulatedLength = 0;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (finishedFirstSentence) {
      trailingNodes.push(node);
      continue;
    }

    if (node.type === 'text' && typeof node.value === 'string') {
      let val = node.value;
      // Preserve leading whitespace outside the mark so the marker stroke starts cleanly on the first word
      if (markChildren.length === 0 && !initialLeadingSpace) {
        const leadingMatch = /^(\s+)/.exec(val);
        if (leadingMatch) {
          initialLeadingSpace = leadingMatch[1];
          val = val.slice(initialLeadingSpace.length);
        }
      }

      const minRemaining = Math.max(1, 18 - accumulatedLength);
      const boundaryRe = new RegExp(`^([\\s\\S]{${minRemaining},}?[.;—])(\\s+[\\s\\S]*)$`);
      const boundaryMatch = boundaryRe.exec(val);
      if (boundaryMatch) {
        markChildren.push({ type: 'text', value: boundaryMatch[1] });
        trailingNodes.push({ type: 'text', value: boundaryMatch[2] });
        accumulatedLength += boundaryMatch[1].length;
        finishedFirstSentence = true;
      } else if (val.length > 0) {
        markChildren.push({ type: 'text', value: val });
        accumulatedLength += val.length;
      }
    } else {
      markChildren.push(node);
      accumulatedLength += getPlainText(node).length;
    }
  }

  if (markChildren.length === 0) return null;
  const markNode = createMarkNode(markChildren, counter.count++);
  return [
    ...(initialLeadingSpace ? [{ type: 'text', value: initialLeadingSpace }] : []),
    markNode,
    ...trailingNodes,
  ];
}

/**
 * Remark plugin that transforms `==important idea==` syntax (and a smart fallback
 * for unmarked lessons) into `<mark class="highlighter-mark">` elements.
 */
export function remarkHighlighter() {
  return (tree: MdastNode) => {
    const counter = { count: 0 };
    transformExplicitHighlights(tree, counter);
    transformStreamingTailHighlight(tree, counter);

    if (counter.count === 0) {
      applySmartFallbackHighlights(tree, counter);
    }
  };
}
