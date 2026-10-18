'use client';

import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ChatInboxPage } from '@marketplace-sandbox/contracts';
import { useCallback, useEffect, useRef } from 'react';
import { useTabActive } from '@/hooks/use-tab-active';
import { chatApi } from '@/lib/api/chat';
import { createReadTracker, type ReadTracker } from '@/lib/chat/read-position';
import { queryKeys } from '@/lib/query-keys';

/** A row counts as seen when it is in the visible part of the list, at least its bottom edge (W05 AS-31). */
function bottomEdgeSeen(entry: IntersectionObserverEntry): boolean {
  return entry.isIntersecting && Math.abs(entry.intersectionRect.bottom - entry.boundingClientRect.bottom) < 1;
}

/**
 * Read marking for one conversation (W05 FR-046, AS-31, AS-36). Message rows report when they are in view through
 * `observe`; the highest `seq` in view goes to the tracker, which sends it only while the tab is visible and focused, after a
 * 500 ms debounce, never twice and never lower, and waits out a `429`. The inbox badge is set from the answer, never guessed.
 * Only other members' messages are observed: the member's own sends mark nothing.
 */
export function useReadTracker(channelId: string): { observe: (element: Element, seq: number) => () => void } {
  const queryClient = useQueryClient();
  const active = useTabActive();
  const tracker = useRef<ReadTracker | null>(null);

  // The tracker lives exactly as long as the effect: React may run an effect, undo it and run it again (development).
  useEffect(() => {
    tracker.current = createReadTracker({
      markRead: (seq) => chatApi.markRead(channelId, seq),
      onResult: ({ unread }) => {
        queryClient.setQueryData<InfiniteData<ChatInboxPage>>(queryKeys.chat.inbox(), (held) =>
          held ? { ...held, pages: held.pages.map((page) => ({ ...page, items: page.items.map((item) => (item.id === channelId ? { ...item, unread } : item)) })) } : held,
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.chat.unreadTotal() });
      },
    });
    return () => {
      tracker.current?.dispose();
      tracker.current = null;
    };
  }, [channelId, queryClient]);

  useEffect(() => {
    tracker.current?.setActive(active);
  }, [channelId, queryClient, active]);

  const seqs = useRef(new Map<Element, number>());
  const seen = useRef(new Set<Element>());
  const observer = useRef<IntersectionObserver | null>(null);

  const observe = useCallback((element: Element, seq: number) => {
    observer.current ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (bottomEdgeSeen(entry)) seen.current.add(entry.target);
        else seen.current.delete(entry.target);
      }
      let highest = 0;
      for (const visible of seen.current) highest = Math.max(highest, seqs.current.get(visible) ?? 0);
      if (highest > 0) tracker.current?.report(highest);
    });
    seqs.current.set(element, seq);
    observer.current.observe(element);
    return () => {
      observer.current?.unobserve(element);
      seqs.current.delete(element);
      seen.current.delete(element);
    };
  }, []);

  useEffect(() => {
    return () => {
      observer.current?.disconnect();
      observer.current = null;
    };
  }, []);

  return { observe };
}
