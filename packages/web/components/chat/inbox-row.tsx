import Link from 'next/link';
import type { ChatInboxItem } from '@marketplace-sandbox/contracts';
import { unreadLabel, unreadName } from '@/lib/chat/inbox';
import { chatHref } from '@/lib/chat/links';
import { inboxTime } from '@/lib/chat/time-format';

/** One chat of the inbox: a link to `?channel=` (so Back, reload and sharing work), never a button (W05 AS-07). */
export function InboxRow({
  item,
  isOpen,
  now,
  register,
}: {
  item: ChatInboxItem;
  isOpen: boolean;
  now: number;
  /** Lets the shell return focus to this row when the conversation closes (AS-38). */
  register?: (channelId: string, element: HTMLAnchorElement | null) => void;
}) {
  const time = inboxTime(item.lastMessageAt, now);
  return (
    <Link
      ref={(element) => register?.(item.id, element)}
      href={chatHref({ channel: item.id })}
      aria-current={isOpen ? 'page' : undefined}
      data-testid="chat-channel"
      className="flex min-h-14 items-center gap-3 px-3 py-2 outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:bg-muted"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.title}</span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-foreground/70">
          {item.isArchived && <span className="rounded border px-1.5 py-0.5 text-[0.7rem] font-medium">Archived</span>}
          {time && <time dateTime={item.lastMessageAt ?? undefined}>{time}</time>}
        </span>
      </span>
      {item.unread > 0 && (
        <span className="shrink-0">
          <span aria-hidden="true" className="inline-flex min-w-6 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-xs font-semibold text-primary-foreground">
            {unreadLabel(item.unread)}
          </span>
          <span className="sr-only">{unreadName(item.unread)}</span>
        </span>
      )}
    </Link>
  );
}
