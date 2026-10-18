'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { chatApi } from '@/lib/api/chat';
import { inboxItems } from '@/lib/chat/inbox';
import { queryKeys } from '@/lib/query-keys';

export const INBOX_PAGE_SIZE = 50;
export const INBOX_POLL_MS = 30_000;

/**
 * The member's chats, one infinite query under `queryKeys.chat.inbox()` (W05 FR-010, FR-070). The first page is usually
 * hydrated by the server. `poll` (the inbox component only) re-reads it every 30 s while the tab is visible; TanStack does not
 * run the interval in a hidden tab (AS-10). The shell and the live hook read the same entry without polling.
 */
export function useInbox({ poll = false }: { poll?: boolean } = {}) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.chat.inbox(),
    queryFn: ({ pageParam }) => chatApi.inbox({ limit: INBOX_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...(poll ? { refetchInterval: INBOX_POLL_MS } : {}),
  });
  return { query, items: inboxItems(query.data) };
}
