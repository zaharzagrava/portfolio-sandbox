'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { TranscriptMessage } from '@/hooks/use-assistant-chat';
import { ChatMessage } from './chat-message';

const NEAR_END_PX = 24;

/**
 * The conversation: the sheet's only scroller (W05 AS-65, AS-66). `role="log"` named for the conversation, `aria-busy` while a
 * reply streams and deliberately not `aria-live` (streamed text would be read word by word); two visually hidden polite regions
 * carry "The assistant is answering…" and the end note. The view follows the end of the answer unless the reader scrolled up.
 */
export function Transcript({ items, busy, announce, empty }: { items: TranscriptMessage[]; busy: boolean; announce: { start: string; end: string }; empty?: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [items]);

  const onScroll = () => {
    const element = scroller.current;
    if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_END_PX;
  };

  return (
    <>
      <div
        ref={scroller}
        role="log"
        aria-label="Conversation with the assistant"
        aria-busy={busy}
        onScroll={onScroll}
        tabIndex={0}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 motion-safe:scroll-smooth"
      >
        {items.map((message) => (
          <ChatMessage key={message.id} message={message} />
        ))}
        {items.length === 0 && empty}
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {announce.start}
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {announce.end}
      </div>
    </>
  );
}
