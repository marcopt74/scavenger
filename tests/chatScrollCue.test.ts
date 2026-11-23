import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ChatMessageList,
  SCROLL_BOTTOM_THRESHOLD_PX,
  hasUnseenContentBelow,
} from '../src/client/components/ChatMessageList.js';
import type { ChatMessage } from '../src/shared/types.js';

const sampleMessages: ChatMessage[] = [
  {
    id: 'msg_1',
    role: 'assistant',
    content: 'Welcome to the repository architecture walkthrough.',
    createdAt: '2026-01-01T00:00:00.000Z',
    stage: 1,
    topicTitle: 'Big Picture & Purpose',
  },
];

describe('ChatMessageList non-scrolling behavior & downward arrow visual cue', () => {
  it('computes whether unseen content exists below the viewport fold', () => {
    // Non-scrollable or zero-dimension container
    expect(
      hasUnseenContentBelow({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })
    ).toBe(false);
    expect(
      hasUnseenContentBelow({ scrollTop: 0, scrollHeight: 500, clientHeight: 600 })
    ).toBe(false);

    // At the very bottom
    expect(
      hasUnseenContentBelow({ scrollTop: 400, scrollHeight: 1000, clientHeight: 600 })
    ).toBe(false);

    // Within threshold tolerance of the bottom
    expect(
      hasUnseenContentBelow({
        scrollTop: 400 - SCROLL_BOTTOM_THRESHOLD_PX,
        scrollHeight: 1000,
        clientHeight: 600,
      })
    ).toBe(false);

    // User is reading near the top while new content extends below the viewport
    expect(
      hasUnseenContentBelow({
        scrollTop: 0,
        scrollHeight: 1200,
        clientHeight: 600,
      })
    ).toBe(true);

    // Just beyond the bottom threshold
    expect(
      hasUnseenContentBelow({
        scrollTop: 400 - SCROLL_BOTTOM_THRESHOLD_PX - 1,
        scrollHeight: 1000,
        clientHeight: 600,
      })
    ).toBe(true);
  });

  it('hides the downward arrow cue when there is no unseen content below', () => {
    const html = renderToStaticMarkup(
      createElement(ChatMessageList, {
        messages: sampleMessages,
        activeTopicTitle: 'Big Picture & Purpose',
        streamingText: '',
        streamingActivities: [],
        streamingVisuals: [],
        isStreaming: false,
        onSelectPrompt: () => {},
        initialHasMoreBelow: false,
      })
    );

    expect(html).toContain('class="chat-scroll-region"');
    expect(html).toContain('class="chat-scroll"');
    expect(html).not.toContain('scroll-down-cue');
  });

  it('renders the downward arrow cue when more content exists below while idle or streaming', () => {
    const idleHtml = renderToStaticMarkup(
      createElement(ChatMessageList, {
        messages: sampleMessages,
        activeTopicTitle: 'Big Picture & Purpose',
        streamingText: '',
        streamingActivities: [],
        streamingVisuals: [],
        isStreaming: false,
        onSelectPrompt: () => {},
        initialHasMoreBelow: true,
      })
    );

    expect(idleHtml).toContain('class="scroll-down-cue"');
    expect(idleHtml).toContain('class="lucide lucide-arrow-down scroll-down-cue-icon"');
    expect(idleHtml).toContain('More content below');
    expect(idleHtml).toContain('aria-label="More content below — scroll down to view"');

    const streamingHtml = renderToStaticMarkup(
      createElement(ChatMessageList, {
        messages: sampleMessages,
        activeTopicTitle: 'System Architecture',
        streamingText: 'Streaming additional section below the fold...',
        streamingActivities: [],
        streamingVisuals: [],
        isStreaming: true,
        onSelectPrompt: () => {},
        initialHasMoreBelow: true,
      })
    );

    expect(streamingHtml).toContain('class="scroll-down-cue is-streaming"');
    expect(streamingHtml).toContain('class="lucide lucide-arrow-down scroll-down-cue-icon"');
    expect(streamingHtml).toContain('New output below');
    expect(streamingHtml).toContain('aria-label="New output below — scroll down to view"');
  });
});
