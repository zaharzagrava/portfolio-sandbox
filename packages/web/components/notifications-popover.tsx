'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useUserEvents, useUserStream, type UserEventHandler } from '@/hooks/use-user-stream';
import {
  applyNotificationEvent,
  inboxErrorKind,
  inboxItems,
  useInbox,
  useMarkAllRead,
  useMarkRead,
  useUnreadCount,
  type NotificationItem,
} from '@/lib/api/notifications';
import { formatWait } from '@/lib/auth/retry-after';
import { queryKeys } from '@/lib/query-keys';
import { safeNotificationLink } from '@/lib/safe-link';
import { formatDistanceToNow } from 'date-fns';

/** When, after the stream connects, the bell reads its count again (see `NotificationsPopover`). */
const STREAM_CATCH_UP_MS = [2_000, 6_000] as const;

function ItemBody({ item }: { item: NotificationItem }) {
  return (
    <>
      <p className={`text-sm leading-tight mb-1 ${item.read ? '' : 'font-semibold'}`}>{item.title}</p>
      {item.body && <p className="text-xs text-muted-foreground mb-1">{item.body}</p>}
      <p className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}</p>
    </>
  );
}

export function NotificationsPopover() {
  const client = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const count = useUnreadCount();
  const inbox = useInbox(isOpen);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();

  const handler = useMemo<UserEventHandler>(
    () => ({
      onEvent: (event) => {
        if (event.type === 'notification') applyNotificationEvent(client, event.data);
      },
      onResync: () => void client.invalidateQueries({ queryKey: queryKeys.notifications.unreadCount() }),
    }),
    [client],
  );
  useUserEvents(handler);

  // The count was read over HTTP before the stream opened, and the stream replays nothing from before it opened or from
  // the moment between its `open` and the hub taking the subscription: an item created in that window (a new account's
  // welcome) would stay unseen until the next focus. Read the count again shortly after the first connect (a reconnect
  // already re-reads through `onResync`).
  const { health } = useUserStream();
  const connected = health === 'connected';
  useEffect(() => {
    if (!connected) return;
    const reread = () => void client.invalidateQueries({ queryKey: queryKeys.notifications.unreadCount() });
    const timers = STREAM_CATCH_UP_MS.map((ms) => setTimeout(reread, ms));
    return () => timers.forEach(clearTimeout);
  }, [connected, client]);

  useEffect(() => {
    const reread = () => void client.invalidateQueries({ queryKey: queryKeys.notifications.unreadCount() });
    window.addEventListener('focus', reread);
    return () => window.removeEventListener('focus', reread);
  }, [client]);

  // A failed count read leaves the bell without a badge (AS-65).
  const unreadCount = count.data?.unread ?? 0;
  const items = inboxItems(inbox.data);
  const error = inbox.isError ? inboxErrorKind(inbox.error) : null;

  const open = (item: NotificationItem) => {
    if (!item.read) markRead.mutate([item.id]);
    setIsOpen(false);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        >
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 rounded-full text-xs"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h4 className="font-semibold text-sm">Notifications</h4>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-auto py-1 px-2"
              disabled={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          {error?.kind === 'unauthenticated' ? null : error ? (
            <div role="alert" className="px-4 py-6 text-center text-sm text-muted-foreground">
              <p>
                {error.kind === 'rate_limited'
                  ? formatWait(error.retryAfterSeconds)
                    ? `Try again in ${formatWait(error.retryAfterSeconds)}.`
                    : 'Try again later.'
                  : "We couldn't load notifications."}
              </p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => void inbox.refetch()}>
                Try again
              </Button>
            </div>
          ) : inbox.isPending && items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground" aria-busy="true">
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No notifications yet
            </div>
          ) : (
            <ul className="flex flex-col">
              {items.map((item) => {
                const href = safeNotificationLink(item.link);
                const style = `block w-full px-4 py-3 text-left border-b hover:bg-muted ${item.read ? '' : 'bg-muted/50'}`;
                return (
                  <li key={item.id} data-read={item.read}>
                    {href ? (
                      <Link href={href} className={style} onClick={() => open(item)}>
                        <ItemBody item={item} />
                      </Link>
                    ) : (
                      <button type="button" className={style} onClick={() => open(item)}>
                        <ItemBody item={item} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!error && inbox.hasNextPage && (
            <div className="p-2 text-center">
              <Button variant="ghost" size="sm" disabled={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()}>
                Show older
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
