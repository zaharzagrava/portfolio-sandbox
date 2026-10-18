'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { InboxRow } from '@/components/chat/inbox-row';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useClock } from '@/hooks/use-clock';
import { useInbox } from '@/hooks/use-inbox';
import { chatProblem } from '@/lib/api/chat';
import { searchHref } from '@/lib/routes';

/**
 * "Your chats" (W05 AS-07..AS-10): one call (`GET /chat/channels/mine`), rows in the order the API gives, unread from the
 * server. It reads again on focus, when the tab becomes visible, every 30 s while visible, and whenever another part of the
 * page invalidates `queryKeys.chat.inbox()` (a send, a live hint, a reconnect).
 */
export function Inbox({ openId, registerRow }: { openId: string | null; registerRow?: (channelId: string, element: HTMLAnchorElement | null) => void }) {
  const { query, items } = useInbox({ poll: true });
  const now = useClock();
  const { refetch } = query;

  useEffect(() => {
    const again = () => void refetch({ cancelRefetch: false });
    const onVisible = () => {
      if (document.visibilityState === 'visible') again();
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refetch]);

  const failedFirstRead = query.isError && !query.data;
  const loading = query.isPending;

  return (
    <nav aria-label="Your chats" aria-busy={loading ? 'true' : undefined} className="flex min-h-0 flex-1 flex-col">
      {loading && (
        <>
          <p role="status" className="sr-only">
            Loading chats…
          </p>
          <ul aria-hidden="true" className="divide-y">
            {['a', 'b', 'c', 'd'].map((id) => (
              <li key={id} className="flex min-h-14 items-center gap-3 px-3 py-2">
                <Skeleton className="h-4 flex-1 motion-reduce:animate-none" />
                <Skeleton className="h-4 w-8 motion-reduce:animate-none" />
              </li>
            ))}
          </ul>
        </>
      )}

      {failedFirstRead && (
        <div role="alert" className="m-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          <p>We couldn&apos;t load your chats.</p>
          {chatProblem(query.error).requestId && <p className="mt-1 text-xs">Reference: {chatProblem(query.error).requestId}</p>}
          <Button type="button" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      )}

      {!loading && !failedFirstRead && items.length === 0 && (
        <div className="p-4 text-sm text-muted-foreground">
          <p>No chats yet. Open a product and press Chat with seller.</p>
          <Link href={searchHref()} className="mt-3 inline-flex min-h-11 items-center rounded-md border px-3 font-medium text-foreground hover:bg-accent sm:min-h-8">
            Browse products
          </Link>
        </div>
      )}

      {items.length > 0 && (
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
          {items.map((item) => (
            <li key={item.id}>
              <InboxRow item={item} isOpen={item.id === openId} now={now} {...(registerRow ? { register: registerRow } : {})} />
            </li>
          ))}
        </ul>
      )}

      {query.isRefetchError && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          Couldn&apos;t refresh
        </p>
      )}

      {query.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          className="m-3 min-h-11 sm:min-h-8"
          aria-disabled={query.isFetchingNextPage ? 'true' : undefined}
          onClick={() => {
            if (!query.isFetchingNextPage) void query.fetchNextPage();
          }}
        >
          Show more chats
        </Button>
      )}
    </nav>
  );
}
