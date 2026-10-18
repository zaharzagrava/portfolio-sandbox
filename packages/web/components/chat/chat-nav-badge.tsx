'use client';

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/use-auth';
import { chatApi } from '@/lib/api/chat';
import { unreadLabel, unreadName, unreadSum } from '@/lib/chat/inbox';
import { queryKeys } from '@/lib/query-keys';

const FIRST_PAGE = 50;
const REFRESH_MS = 30_000;

/**
 * The total of the unread badges of the first inbox page, or `null` while unknown, for an anonymous visitor, and when the read
 * fails (W05 AS-11). It reads at most every 30 s, and not at all in a hidden tab or for a visitor who is not signed in.
 */
export function useChatUnreadTotal(): number | null {
  const { status } = useAuth();
  const query = useQuery({
    queryKey: queryKeys.chat.unreadTotal(),
    queryFn: async () => unreadSum((await chatApi.inbox({ limit: FIRST_PAGE })).items),
    enabled: status === 'authenticated',
    refetchInterval: REFRESH_MS,
    retry: false,
  });
  return status === 'authenticated' && query.data !== undefined ? query.data : null;
}

/** For W07's navbar: the number in a small badge, nothing at all for 0 or unknown (a count is never guessed). */
export function ChatNavBadge() {
  const total = useChatUnreadTotal();
  if (!total) return null;
  return (
    <span>
      <span aria-hidden="true" className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
        {unreadLabel(total)}
      </span>
      <span className="sr-only">{unreadName(total)}</span>
    </span>
  );
}
