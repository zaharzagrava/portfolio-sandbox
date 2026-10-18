import type { InfiniteData } from '@tanstack/react-query';
import type { ChatMessage, ChatMessagePage } from '@marketplace-sandbox/contracts';

/**
 * Helpers over the history query of one chat, `InfiniteData<ChatMessagePage>` under `queryKeys.chat.messages(id)` (W05
 * FR-011). Pages are newest first; the list on screen is derived from this entry only. Catch-up and a confirmed send write
 * into the newest page; a re-delivered message (same `id`) replaces its copy wherever it is held (AS-25).
 */
export type MessagesData = InfiniteData<ChatMessagePage>;

const byNewest = (a: ChatMessage, b: ChatMessage) => b.seq - a.seq;

/** All held messages, each once, oldest first (ordered by `seq`, never by arrival). */
export function messagesOf(data: MessagesData | undefined): ChatMessage[] {
  if (!data) return [];
  const byId = new Map<string, ChatMessage>();
  for (const page of data.pages) for (const message of page.items) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export function highestSeq(data: MessagesData | undefined): number {
  let highest = 0;
  if (data) for (const page of data.pages) for (const message of page.items) highest = Math.max(highest, message.seq);
  return highest;
}

/** Puts `incoming` into the cache. The same object comes back when nothing arrives or the chat is not loaded. */
export function addMessages(data: MessagesData | undefined, incoming: ChatMessage[]): MessagesData | undefined {
  if (!data || incoming.length === 0 || data.pages.length === 0) return data;
  const arriving = new Map(incoming.map((message) => [message.id, message]));
  const held = new Set<string>();
  const pages = data.pages.map((page) => {
    const items = page.items.map((message) => {
      const replacement = arriving.get(message.id);
      if (!replacement) return message;
      held.add(message.id);
      return replacement;
    });
    return { ...page, items };
  });
  const fresh = incoming.filter((message) => !held.has(message.id));
  const [first, ...rest] = pages;
  if (!first) return data;
  const newest = fresh.length > 0 ? { ...first, items: [...first.items, ...fresh].sort(byNewest) } : first;
  return { ...data, pages: [newest, ...rest] };
}

/** The tombstone: same `seq` and place, no body (AS-20). */
export function markDeleted(data: MessagesData | undefined, messageId: string): MessagesData | undefined {
  if (!data || !data.pages.some((page) => page.items.some((message) => message.id === messageId))) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({ ...page, items: page.items.map((message) => (message.id === messageId ? { ...message, deleted: true, body: null } : message)) })),
  };
}

/**
 * The message the "{n} new messages" separator sits before: the oldest of the `n` newest messages from other members (the
 * server's `unread` never counts the member's own). `null` when there is nothing unread among the loaded messages.
 */
export function unreadDividerId(messages: ChatMessage[], selfId: string | null, unread: number): string | null {
  if (unread <= 0) return null;
  let remaining = unread;
  let found: string | null = null;
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
    const message = messages[index]!;
    if (message.authorId === selfId) continue;
    found = message.id;
    remaining -= 1;
  }
  return found;
}
