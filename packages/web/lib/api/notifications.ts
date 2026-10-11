'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import {
  notificationPageSchema,
  unreadCountSchema,
  type MarkReadRequest,
  type NotificationEvent,
  type NotificationItem,
  type NotificationPage,
  type UnreadCount,
} from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { endSession } from '@/lib/auth/session-ended';
import { apiClient } from './client';
import { problemFromError } from './errors';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';
import { believesSignedIn } from './session-presence';

export type { NotificationItem, NotificationPage, UnreadCount };
export type InboxData = InfiniteData<NotificationPage, string | null>;

export const INBOX_PAGE_SIZE = 20;

/** A `401` anywhere in the inbox is the session ending: hand over to W01's flow (once; the latch is in `endSession`). */
function handOffUnauthorised(error: unknown): never {
  if (problemFromError(error).status === 401 && believesSignedIn()) endSession();
  throw error;
}

export async function fetchUnreadCount(): Promise<UnreadCount> {
  try {
    const { data } = await apiClient.get<unknown>('/api/notifications/unread-count');
    return parseBody(unreadCountSchema, data);
  } catch (error) {
    return handOffUnauthorised(error);
  }
}

export async function fetchInboxPage(cursor: string | null): Promise<NotificationPage> {
  try {
    const { data } = await apiClient.get<unknown>('/api/notifications', { params: { limit: INBOX_PAGE_SIZE, ...(cursor ? { cursor } : {}) } });
    return parseBody(notificationPageSchema, data);
  } catch (error) {
    return handOffUnauthorised(error);
  }
}

export async function postMarkRead(request: MarkReadRequest): Promise<UnreadCount> {
  try {
    const { data } = await apiClient.post<unknown>('/api/notifications/read', request);
    return parseBody(unreadCountSchema, data);
  } catch (error) {
    return handOffUnauthorised(error);
  }
}

/** The bell's count; `enabled` is false for anonymous visitors. Read on mount and on tab focus (query defaults). */
export function useUnreadCount(enabled = true) {
  return useQuery({
    queryKey: queryKeys.notifications.unreadCount(),
    queryFn: fetchUnreadCount,
    enabled,
    // A failed read leaves the bell without a badge (AS-65); the next focus or mount reads again.
    retry: false,
  });
}

/** The popover's list: newest first, 20 per page, cursor pages appended (AS-62, AS-67). */
export function useInbox(enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.notifications.inbox(),
    queryFn: ({ pageParam }) => fetchInboxPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    retry: retryUnlessClientError,
  });
}

/** All loaded items, in order, each `id` once (a live event and a later page may carry the same one). */
export function inboxItems(data: { pages: NotificationPage[] } | undefined): NotificationItem[] {
  const seen = new Set<string>();
  const out: NotificationItem[] = [];
  for (const page of data?.pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

type Snapshot = { count: UnreadCount | undefined; inbox: InboxData | undefined };

function mapInbox(data: InboxData | undefined, change: (item: NotificationItem) => NotificationItem): InboxData | undefined {
  return data && { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map(change) })) };
}

function createMarkMutation<V>(toRequest: (variables: V) => MarkReadRequest, shouldMark: (variables: V) => (item: NotificationItem) => boolean, nextCount: (variables: V, flipped: number, current: number) => number) {
  return (client: QueryClient) => ({
    mutationFn: (variables: V) => postMarkRead(toRequest(variables)),
    onMutate: async (variables: V): Promise<Snapshot> => {
      await client.cancelQueries({ queryKey: queryKeys.notifications.all });
      const snapshot: Snapshot = {
        count: client.getQueryData<UnreadCount>(queryKeys.notifications.unreadCount()),
        inbox: client.getQueryData<InboxData>(queryKeys.notifications.inbox()),
      };
      const matches = shouldMark(variables);
      const flipped = inboxItems(snapshot.inbox).filter((item) => !item.read && matches(item)).length;
      client.setQueryData<InboxData>(queryKeys.notifications.inbox(), (data) => mapInbox(data, (item) => (matches(item) ? { ...item, read: true } : item)));
      if (snapshot.count) client.setQueryData<UnreadCount>(queryKeys.notifications.unreadCount(), { unread: nextCount(variables, flipped, snapshot.count.unread) });
      return snapshot;
    },
    onError: (_error: unknown, _variables: V, snapshot: Snapshot | undefined) => {
      if (!snapshot) return;
      client.setQueryData(queryKeys.notifications.unreadCount(), snapshot.count);
      client.setQueryData(queryKeys.notifications.inbox(), snapshot.inbox);
    },
    onSuccess: (count: UnreadCount) => {
      client.setQueryData(queryKeys.notifications.unreadCount(), count);
    },
  });
}

const markReadOptions = createMarkMutation<string[]>(
  (ids) => ({ ids }),
  (ids) => (item) => ids.includes(item.id),
  (_ids, flipped, current) => Math.max(0, current - flipped),
);
const markAllOptions = createMarkMutation<void>(
  () => ({ all: true }),
  () => () => true,
  () => 0,
);

/** Marks the given ids read: optimistic, rolled back on failure, the server's count wins on success (FR-063). */
export function useMarkRead() {
  return useMutation(markReadOptions(useQueryClient()));
}

/** Marks everything read: count 0 at once, rolled back on failure. */
export function useMarkAllRead() {
  return useMutation(markAllOptions(useQueryClient()));
}

/**
 * Applies a live `notification` event (AS-66). Returns false for an `id` already known (nothing changes). A new item is
 * prepended to the loaded first page; the unread count becomes the event's `unread`, which is the server's own count
 * after storing the item.
 */
export function applyNotificationEvent(client: QueryClient, event: NotificationEvent): boolean {
  const inbox = client.getQueryData<InboxData>(queryKeys.notifications.inbox());
  if (inboxItems(inbox).some((item) => item.id === event.id)) return false;
  const { unread, ...fields } = event;
  const item: NotificationItem = { ...fields, read: false };
  if (inbox && inbox.pages.length > 0) {
    const [first, ...rest] = inbox.pages;
    client.setQueryData<InboxData>(queryKeys.notifications.inbox(), { ...inbox, pages: [{ ...first, items: [item, ...first.items] }, ...rest] });
  }
  client.setQueryData<UnreadCount>(queryKeys.notifications.unreadCount(), { unread });
  return true;
}

export type InboxErrorKind = { kind: 'unauthenticated' } | { kind: 'rate_limited'; retryAfterSeconds?: number } | { kind: 'failed' };

/** What the popover shows for a failed call (AS-65). */
export function inboxErrorKind(error: unknown): InboxErrorKind {
  const problem = problemFromError(error);
  if (problem.status === 401) return { kind: 'unauthenticated' };
  if (problem.status === 429) return { kind: 'rate_limited', ...(problem.retryAfterSeconds !== undefined ? { retryAfterSeconds: problem.retryAfterSeconds } : {}) };
  return { kind: 'failed' };
}
