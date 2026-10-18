import type { InfiniteData } from '@tanstack/react-query';
import type { ChatInboxItem, ChatInboxPage } from '@marketplace-sandbox/contracts';

/**
 * View helpers over the inbox query (W05 AS-07, AS-09, AS-11). The numbers are the server's `unread`; nothing here derives
 * them from messages on screen (FR-013).
 */

/** All loaded pages in the order the API gave them, each chat once (a chat that moved between pages keeps its first place). */
export function inboxItems(data: InfiniteData<ChatInboxPage> | undefined): ChatInboxItem[] {
  if (!data) return [];
  const seen = new Set<string>();
  const items: ChatInboxItem[] = [];
  for (const page of data.pages)
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  return items;
}

export const unreadLabel = (unread: number): string => (unread > 99 ? '99+' : String(unread));

export const unreadName = (unread: number): string => `${unread} unread message${unread === 1 ? '' : 's'}`;

export const unreadSum = (items: { unread: number }[]): number => items.reduce((sum, item) => sum + item.unread, 0);
