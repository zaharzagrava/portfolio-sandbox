'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import {
  deviceListSchema,
  deviceSchema,
  notificationPageSchema,
  notificationPreferencesSchema,
  UNREAD_COUNT_BOUND,
  unreadCountSchema,
  unsubscribeResultSchema,
  type Device,
  type DeviceList,
  type MarkReadRequest,
  type NotificationRealtimeEvent,
  type NotificationItem,
  type NotificationPage,
  type NotificationPreferences,
  type RegisterDeviceRequest,
  type UnreadCount,
  type UpdatePreferenceRequest,
  type UpdateSettingsRequest,
} from '@marketplace-sandbox/contracts';
import type { ZodType } from 'zod';
import { queryKeys } from '@/lib/query-keys';
import { formatWait } from '@/lib/auth/retry-after';
import { endSession } from '@/lib/auth/session-ended';
import { apiClient } from './client';
import { problemFromError } from './errors';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';
import { believesSignedIn } from './session-presence';

export type { Device, DeviceList, NotificationItem, NotificationPage, NotificationPreferences, UnreadCount };
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
 * prepended to the loaded first page. The event carries no count (`unread` is the item's own flag), so a known count
 * grows by one when the item arrives unread; focus and reconnect re-read the server's count.
 */
export function applyNotificationEvent(client: QueryClient, event: NotificationRealtimeEvent): boolean {
  const inbox = client.getQueryData<InboxData>(queryKeys.notifications.inbox());
  if (inboxItems(inbox).some((item) => item.id === event.id)) return false;
  const { unread, ...fields } = event;
  const item: NotificationItem = { ...fields, read: !unread };
  if (inbox && inbox.pages.length > 0) {
    const [first, ...rest] = inbox.pages;
    client.setQueryData<InboxData>(queryKeys.notifications.inbox(), { ...inbox, pages: [{ ...first, items: [item, ...first.items] }, ...rest] });
  }
  const count = client.getQueryData<UnreadCount>(queryKeys.notifications.unreadCount());
  if (unread && count) client.setQueryData<UnreadCount>(queryKeys.notifications.unreadCount(), { unread: Math.min(UNREAD_COUNT_BOUND, count.unread + 1) });
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

// --- preferences, settings, phone, devices, unsubscribe ----------------------------------------------------------------

async function send<T>(schema: ZodType<T>, request: Promise<{ data: unknown }>): Promise<T> {
  try {
    const { data } = await request;
    return parseBody(schema, data);
  } catch (error) {
    return handOffUnauthorised(error);
  }
}

export const fetchPreferences = () => send(notificationPreferencesSchema, apiClient.get<unknown>('/api/notifications/preferences'));

export const putPreference = (request: UpdatePreferenceRequest) =>
  send(notificationPreferencesSchema, apiClient.put<unknown>('/api/notifications/preferences', request));

export const putSettings = (request: UpdateSettingsRequest) =>
  send(notificationPreferencesSchema, apiClient.put<unknown>('/api/notifications/settings', request));

/** Asks for a new 6-digit code by SMS to the stored phone: `202 {}`. */
export async function postPhoneCode(): Promise<void> {
  try {
    await apiClient.post<unknown>('/api/notifications/settings/phone/code');
  } catch (error) {
    handOffUnauthorised(error);
  }
}

export const postPhoneVerify = (code: string) =>
  send(notificationPreferencesSchema, apiClient.post<unknown>('/api/notifications/settings/phone/verify', { code }));

export const listDevices = (): Promise<DeviceList> => send(deviceListSchema, apiClient.get<unknown>('/api/notifications/devices'));

/** `201` for a new token, `200` for a known one; never carries the token back. */
export const registerDevice = (request: RegisterDeviceRequest): Promise<Device> =>
  send(deviceSchema, apiClient.post<unknown>('/api/notifications/devices', request));

export async function removeDevice(deviceId: string): Promise<void> {
  try {
    await apiClient.delete(`/api/notifications/devices/${encodeURIComponent(deviceId)}`);
  } catch (error) {
    handOffUnauthorised(error);
  }
}

/** Anonymous: the signed token is the whole proof. `GET` only describes (the page does that on the server); this performs it. */
export async function postUnsubscribe(token: string): Promise<string> {
  const { data } = await apiClient.post<unknown>('/api/notifications/unsubscribe', null, { params: { token }, anonymous: true });
  return parseBody(unsubscribeResultSchema, data).unsubscribed;
}

export function usePreferences(enabled = true) {
  return useQuery({
    queryKey: queryKeys.notifications.preferences(),
    queryFn: fetchPreferences,
    enabled,
    retry: retryUnlessClientError,
  });
}

/** One cell: flips at once, the server's whole matrix wins on success, the previous matrix returns on failure (AS-15, AS-18). */
export function useUpdatePreference() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: putPreference,
    onMutate: async ({ category, channel, enabled }: UpdatePreferenceRequest) => {
      await client.cancelQueries({ queryKey: queryKeys.notifications.preferences() });
      const previous = client.getQueryData<NotificationPreferences>(queryKeys.notifications.preferences());
      if (previous) {
        client.setQueryData<NotificationPreferences>(queryKeys.notifications.preferences(), {
          ...previous,
          preferences: previous.preferences.map((row) => (row.category === category ? { ...row, channels: { ...row.channels, [channel]: enabled } } : row)),
        });
      }
      return { previous };
    },
    onError: (_error, _request, context) => {
      if (context?.previous) client.setQueryData(queryKeys.notifications.preferences(), context.previous);
    },
    onSuccess: (matrix) => client.setQueryData(queryKeys.notifications.preferences(), matrix),
  });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: putSettings,
    onSuccess: (matrix) => client.setQueryData(queryKeys.notifications.preferences(), matrix),
  });
}

export function useRequestPhoneCode() {
  return useMutation({ mutationFn: postPhoneCode });
}

export function useVerifyPhone() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: postPhoneVerify,
    onSuccess: (matrix) => client.setQueryData(queryKeys.notifications.preferences(), matrix),
  });
}

/** The visible text of a failed settings, preference or phone call, from the stable `code` and status only. */
export function settingsErrorText(error: unknown): string {
  const problem = problemFromError(error);
  const wait = formatWait(problem.retryAfterSeconds);
  switch (problem.code) {
    case 'phone_not_verified':
      return 'Verify your phone number before turning on text messages.';
    case 'quiet_hours_incomplete':
      return 'Set both the start and the end of quiet hours, or clear both.';
    case 'quiet_hours_invalid':
      return 'Quiet hours cannot start and end at the same time.';
    case 'code_invalid':
      return 'That code is not right. Check the message and try again.';
    case 'code_expired':
      return 'That code has expired. Request a new one.';
    case 'code_not_requested':
      return 'Request a code first.';
    case 'phone_missing':
      return 'Add a phone number first.';
    case 'phone_unreachable':
      return "We can't send text messages to that number.";
    case 'verification_locked':
      return wait ? `Too many wrong codes. Try again in ${wait}.` : 'Too many wrong codes. Try again later.';
    case 'validation_failed':
      return 'Check the values and try again.';
    default:
  }
  if (problem.status === 429) return wait ? `Too many requests. Try again in ${wait}.` : 'Too many requests. Try again later.';
  if (problem.status === 0) return "You're offline. Check your connection and try again.";
  return 'Something went wrong. Try again.';
}
