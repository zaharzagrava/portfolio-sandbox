'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { StreamBanner } from '@/components/checkout/stream-banner';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { useUserEvents, useUserStream, type UserEventHandler } from '@/hooks/use-user-stream';
import {
  applyNotificationEvent,
  inboxErrorKind,
  inboxItems,
  useInbox,
  useMarkAllRead,
  useMarkRead,
  useUnreadCount,
  type InboxData,
  type NotificationItem,
} from '@/lib/api/notifications';
import { formatWait } from '@/lib/auth/retry-after';
import { queryKeys } from '@/lib/query-keys';
import { BellButton } from './bell-button';
import { NotificationRow } from './notification-item';

/** When, after the stream connects, the bell reads its count again: an item created between the HTTP read and the hub taking the subscription would stay unseen. */
const STREAM_CATCH_UP_MS = [2_000, 6_000] as const;
/** At most one spoken "New notification" in this window (W03 AS-66). */
const ANNOUNCE_EVERY_MS = 5_000;

function Skeletons() {
  return (
    <div role="status" className="p-4">
      <span className="sr-only">Loading notifications</span>
      <div aria-hidden="true" className="space-y-3">
        {['a', 'b', 'c'].map((key) => (
          <div key={key} className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The bell and its inbox (W03 US6, AS-61..AS-69): count in the name, a non-modal panel with the latest 20 items, optimistic
 * read and read-all, live arrival from `user:<id>`, Show older, and re-reads on focus, reconnect and `resync`. Signed-in
 * members only. Text only: nothing from the server is interpreted as HTML and only same-site links are links.
 */
export function NotificationsPopover() {
  const { user } = useAuth();
  const signedIn = Boolean(user);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const count = useUnreadCount(signedIn);
  const inbox = useInbox(signedIn && open);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();

  // --- spoken updates ----------------------------------------------------------------------------------------------------
  const [announcement, setAnnouncement] = useState('');
  const lastSpoken = useRef(0);
  const speakThrottled = useCallback((text: string) => {
    const now = Date.now();
    if (now - lastSpoken.current < ANNOUNCE_EVERY_MS) return;
    lastSpoken.current = now;
    setAnnouncement(text);
  }, []);

  // --- live --------------------------------------------------------------------------------------------------------------
  /** Re-reads the count and, when the panel has loaded, only its first page (a long list would cost one read per page). */
  const reread = useCallback(() => {
    void client.invalidateQueries({ queryKey: queryKeys.notifications.unreadCount() });
    client.setQueryData<InboxData>(queryKeys.notifications.inbox(), (data) => data && { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) });
    void client.invalidateQueries({ queryKey: queryKeys.notifications.inbox() });
  }, [client]);

  const handler = useMemo<UserEventHandler>(
    () => ({
      onEvent: (event) => {
        if (event.type !== 'notification') return;
        if (applyNotificationEvent(client, event.data) && event.data.unread) speakThrottled(`New notification: ${event.data.title}`);
      },
      onResync: reread,
    }),
    [client, reread, speakThrottled],
  );
  useUserEvents(handler);

  const { health } = useUserStream();
  const connected = health === 'connected';
  useEffect(() => {
    if (!connected) return;
    const again = () => void client.invalidateQueries({ queryKey: queryKeys.notifications.unreadCount() });
    const timers = STREAM_CATCH_UP_MS.map((ms) => setTimeout(again, ms));
    return () => timers.forEach(clearTimeout);
  }, [connected, client]);

  useEffect(() => {
    const again = () => void client.invalidateQueries({ queryKey: queryKeys.notifications.unreadCount() });
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [client]);

  // --- items -------------------------------------------------------------------------------------------------------------
  const items = inboxItems(inbox.data);
  const error = inbox.isError ? inboxErrorKind(inbox.error) : null;
  const unread = count.data?.unread ?? null;

  const rows = useRef(new Map<string, HTMLLIElement>());
  // Show older asks for focus on the first new item; it is given once that item has rendered.
  const pendingFocus = useRef<string | null>(null);
  const [focusTick, requestFocus] = useState(0);
  useEffect(() => {
    const wanted = pendingFocus.current;
    const node = wanted ? rows.current.get(wanted) : undefined;
    if (!node) return;
    node.focus();
    pendingFocus.current = null;
  }, [focusTick, items.length]);

  const showOlder = async () => {
    const known = new Set(items.map((item) => item.id));
    const result = await inbox.fetchNextPage();
    const first = inboxItems(result.data).find((item) => !known.has(item.id));
    if (first) {
      pendingFocus.current = first.id;
      requestFocus((n) => n + 1);
    }
  };

  const follow = (item: NotificationItem) => {
    if (!item.read) {
      markRead.mutate([item.id], { onError: () => toast.error("We couldn't mark that notification as read. Try again.") });
    }
    setOpen(false);
  };

  const readAll = () =>
    markAll.mutate(undefined, {
      onSuccess: () => setAnnouncement('All notifications marked as read'),
      onError: () => toast.error("We couldn't mark your notifications as read. Try again."),
    });

  if (!signedIn) return null;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <BellButton unread={unread} />
        </PopoverTrigger>
        <PopoverContent
          aria-label="Notifications"
          align="end"
          collisionPadding={16}
          className="flex max-h-[70vh] w-[calc(100vw-2rem)] flex-col gap-0 p-0 sm:w-96"
        >
          <div className="space-y-2 border-b px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Notifications</h2>
              {unread !== null && unread > 0 && (
                <Button type="button" variant="ghost" size="sm" className="h-auto min-h-11 px-2 py-1 text-xs sm:min-h-7" disabled={markAll.isPending} onClick={readAll}>
                  Mark all as read
                </Button>
              )}
            </div>
            <StreamBanner />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {error?.kind === 'unauthenticated' ? null : error ? (
              <div role="alert" className="px-4 py-6 text-center text-sm text-muted-foreground">
                <p>
                  {error.kind === 'rate_limited'
                    ? formatWait(error.retryAfterSeconds)
                      ? `Try again in ${formatWait(error.retryAfterSeconds)}.`
                      : 'Try again later.'
                    : "We couldn't load notifications."}
                </p>
                <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11 sm:min-h-7" onClick={() => void inbox.refetch()}>
                  Try again
                </Button>
              </div>
            ) : inbox.isPending && items.length === 0 ? (
              <Skeletons />
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">You&apos;re all caught up.</p>
            ) : (
              <ul aria-label="Notifications">
                {items.map((item) => (
                  <NotificationRow
                    key={item.id}
                    item={item}
                    onFollow={follow}
                    itemRef={(node) => {
                      if (node) rows.current.set(item.id, node);
                      else rows.current.delete(item.id);
                    }}
                  />
                ))}
              </ul>
            )}
            {!error && inbox.hasNextPage && (
              <div className="p-2 text-center">
                <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-7" disabled={inbox.isFetchingNextPage} onClick={() => void showOlder()}>
                  Show older
                </Button>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  );
}
