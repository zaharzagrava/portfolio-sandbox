'use client';

import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';
import type { Ref } from 'react';
import type { NotificationItem } from '@/lib/api/notifications';
import { formatMoment } from '@/lib/orders/format';
import { safeNotificationLink } from '@/lib/safe-link';

function Body({ item }: { item: NotificationItem }) {
  const created = new Date(item.createdAt);
  const valid = !Number.isNaN(created.getTime());
  return (
    <>
      <span className="flex items-start gap-2">
        {!item.read && <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />}
        <span className="min-w-0">
          <span className={`block break-words text-sm leading-tight ${item.read ? '' : 'font-semibold'}`}>
            {!item.read && <span className="sr-only">Unread </span>}
            {item.title}
          </span>
          {item.body && <span className="mt-1 block break-words text-xs text-muted-foreground">{item.body}</span>}
          <time dateTime={item.createdAt} title={formatMoment(item.createdAt)} className="mt-1 block text-xs text-muted-foreground">
            {valid ? formatDistanceToNow(created, { addSuffix: true }) : item.createdAt}
          </time>
        </span>
      </span>
    </>
  );
}

/**
 * One inbox item (W03 AS-62, AS-63): title, body and time as plain text, an "Unread" marker (dot plus screen-reader text).
 * With a same-site link the whole item is that link; anything else is text and not a tab stop. The `li` takes focus
 * programmatically (Show older) and is never a tab stop itself.
 */
export function NotificationRow({ item, onFollow, itemRef }: { item: NotificationItem; onFollow: (item: NotificationItem) => void; itemRef?: Ref<HTMLLIElement> }) {
  const href = safeNotificationLink(item.link);
  const style = 'block w-full px-4 py-3 text-left hover:bg-muted focus-visible:bg-muted';
  return (
    <li ref={itemRef} tabIndex={-1} className={`border-b outline-none last:border-b-0 focus-visible:ring-2 focus-visible:ring-ring ${item.read ? '' : 'bg-muted/50'}`}>
      {href ? (
        <Link href={href} className={`${style} min-h-11`} onClick={() => onFollow(item)}>
          <Body item={item} />
        </Link>
      ) : (
        <div className={style}>
          <Body item={item} />
        </div>
      )}
    </li>
  );
}
