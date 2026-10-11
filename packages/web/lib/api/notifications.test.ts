import type { ReactNode } from 'react';
import { createElement } from 'react';
import { InfiniteData, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { setSessionPresence } from './session-presence';
import {
  applyNotificationEvent,
  inboxErrorKind,
  inboxItems,
  useInbox,
  useMarkAllRead,
  useMarkRead,
  useUnreadCount,
  type InboxData,
} from './notifications';

const origin = 'http://localhost:3000';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, read = false) => ({ id: id(n), type: 'order', category: 'orders', title: `T${n}`, body: `B${n}`, link: '/orders', read, createdAt: '2026-10-11T10:00:00.000Z' });

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, Wrapper };
}

const seedInbox = (client: QueryClient, items = [item(1), item(2, true), item(3)]) =>
  client.setQueryData<InfiniteData<{ items: ReturnType<typeof item>[]; nextCursor: string | null }, string | null>>(queryKeys.notifications.inbox(), {
    pages: [{ items, nextCursor: null }],
    pageParams: [null],
  });

describe('notifications api', () => {
  const ended = vi.fn();
  beforeEach(() => {
    ended.mockClear();
    rearmSessionEnd();
    setSessionEndHandler(ended);
    setSessionPresence(() => true);
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('W03 AS-61: useUnreadCount reads /api/notifications/unread-count and parses unreadCountSchema', async () => {
    server.use(http.get(`${origin}/api/notifications/unread-count`, () => HttpResponse.json({ unread: 4 })));
    const { Wrapper, client } = wrapper();
    const { result } = renderHook(() => useUnreadCount(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ unread: 4 }));
    expect(client.getQueryData(queryKeys.notifications.unreadCount())).toEqual({ unread: 4 });
  });

  it('W03 AS-61: useUnreadCount(false) makes no request (anonymous visitors)', () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUnreadCount(false), { wrapper: Wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('W03 AS-65: a failed unread-count read leaves no data (no badge)', async () => {
    server.use(http.get(`${origin}/api/notifications/unread-count`, () => HttpResponse.json({ code: 'internal' }, { status: 500 })));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUnreadCount(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('W03 AS-62: useInbox loads 20 per page, and AS-67 Show older appends the next cursor page without duplicates', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get(`${origin}/api/notifications`, ({ request }) => {
        const url = new URL(request.url);
        seen.push(url.searchParams.get('cursor'));
        expect(url.searchParams.get('limit')).toBe('20');
        return url.searchParams.get('cursor')
          ? HttpResponse.json({ items: [item(2), item(3)], nextCursor: null })
          : HttpResponse.json({ items: [item(1), item(2)], nextCursor: 'c2' });
      }),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useInbox(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(seen).toEqual([null, 'c2']);
    expect(inboxItems(result.current.data).map((i) => i.id)).toEqual([id(1), id(2), id(3)]);
  });

  it('W03 AS-63: markRead is optimistic: item read and count drop at once, one POST with {ids}, server count wins', async () => {
    let posted: unknown;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(`${origin}/api/notifications/read`, async ({ request }) => {
        posted = await request.json();
        await gate;
        return HttpResponse.json({ unread: 1 });
      }),
    );
    const { Wrapper, client } = wrapper();
    seedInbox(client);
    client.setQueryData(queryKeys.notifications.unreadCount(), { unread: 2 });
    const { result } = renderHook(() => useMarkRead(), { wrapper: Wrapper });
    act(() => result.current.mutate([id(1)]));
    await waitFor(() => expect(client.getQueryData(queryKeys.notifications.unreadCount())).toEqual({ unread: 1 }));
    expect(inboxItems(client.getQueryData<InboxData>(queryKeys.notifications.inbox())).find((i) => i.id === id(1))?.read).toBe(true);
    release();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(posted).toEqual({ ids: [id(1)] });
    expect(client.getQueryData(queryKeys.notifications.unreadCount())).toEqual({ unread: 1 });
  });

  it('W03 AS-63: a failed markRead rolls the item and the count back', async () => {
    server.use(http.post(`${origin}/api/notifications/read`, () => HttpResponse.json({ code: 'internal' }, { status: 500 })));
    const { Wrapper, client } = wrapper();
    seedInbox(client);
    client.setQueryData(queryKeys.notifications.unreadCount(), { unread: 2 });
    const { result } = renderHook(() => useMarkRead(), { wrapper: Wrapper });
    act(() => result.current.mutate([id(1)]));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(queryKeys.notifications.unreadCount())).toEqual({ unread: 2 });
    expect(inboxItems(client.getQueryData<InboxData>(queryKeys.notifications.inbox())).find((i) => i.id === id(1))?.read).toBe(false);
  });

  it('W03 AS-64: markAllRead sets every item read and the count to 0, posts {all:true}; failure restores', async () => {
    let posted: unknown;
    server.use(
      http.post(`${origin}/api/notifications/read`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ unread: 0 });
      }),
    );
    const { Wrapper, client } = wrapper();
    seedInbox(client);
    client.setQueryData(queryKeys.notifications.unreadCount(), { unread: 2 });
    const { result } = renderHook(() => useMarkAllRead(), { wrapper: Wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(posted).toEqual({ all: true });
    expect(client.getQueryData(queryKeys.notifications.unreadCount())).toEqual({ unread: 0 });
    expect(inboxItems(client.getQueryData<InboxData>(queryKeys.notifications.inbox())).every((i) => i.read)).toBe(true);

    server.use(http.post(`${origin}/api/notifications/read`, () => HttpResponse.json({ code: 'x' }, { status: 503 })));
    seedInbox(client);
    client.setQueryData(queryKeys.notifications.unreadCount(), { unread: 2 });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(queryKeys.notifications.unreadCount())).toEqual({ unread: 2 });
    expect(inboxItems(client.getQueryData<InboxData>(queryKeys.notifications.inbox())).filter((i) => !i.read)).toHaveLength(2);
  });

  it('W03 AS-65: 429 is classified as rate_limited with the Retry-After seconds; 401 as unauthenticated and hands over to W01', async () => {
    server.use(http.get(`${origin}/api/notifications`, () => HttpResponse.json({ code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '17' } })));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useInbox(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(inboxErrorKind(result.current.error)).toEqual({ kind: 'rate_limited', retryAfterSeconds: 17 });

    server.use(http.get(`${origin}/api/notifications/unread-count`, () => HttpResponse.json({ code: 'unauthorized' }, { status: 401 })));
    const second = renderHook(() => useUnreadCount(), { wrapper: Wrapper });
    await waitFor(() => expect(second.result.current.isError).toBe(true));
    expect(inboxErrorKind(second.result.current.error)).toEqual({ kind: 'unauthenticated' });
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('W03 AS-65: any other failure is classified as failed', () => {
    expect(inboxErrorKind({ response: { status: 500, data: {} } })).toEqual({ kind: 'failed' });
    expect(inboxErrorKind(new Error('network'))).toEqual({ kind: 'failed' });
  });
});

describe('applyNotificationEvent', () => {
  const event = (n: number, unread: number) => ({ id: id(n), type: 'order', category: 'orders', title: `T${n}`, body: `B${n}`, link: null, unread, createdAt: '2026-10-11T10:00:00.000Z' });

  it('W03 AS-66: a new id is prepended to the loaded inbox and the unread count follows the event', () => {
    const { client } = wrapper();
    seedInbox(client);
    client.setQueryData(queryKeys.notifications.unreadCount(), { unread: 2 });
    expect(applyNotificationEvent(client, event(9, 3))).toBe(true);
    const items = inboxItems(client.getQueryData<InboxData>(queryKeys.notifications.inbox()));
    expect(items.map((i) => i.id)).toEqual([id(9), id(1), id(2), id(3)]);
    expect(items[0]).toMatchObject({ read: false, title: 'T9' });
    expect(client.getQueryData(queryKeys.notifications.unreadCount())).toEqual({ unread: 3 });
  });

  it('W03 AS-66: an id already known is ignored (no duplicate, count unchanged)', () => {
    const { client } = wrapper();
    seedInbox(client);
    client.setQueryData(queryKeys.notifications.unreadCount(), { unread: 2 });
    expect(applyNotificationEvent(client, event(1, 5))).toBe(false);
    expect(inboxItems(client.getQueryData<InboxData>(queryKeys.notifications.inbox()))).toHaveLength(3);
    expect(client.getQueryData(queryKeys.notifications.unreadCount())).toEqual({ unread: 2 });
  });

  it('W03 AS-66: with no inbox loaded only the count changes; an unknown count is seeded from the event', () => {
    const { client } = wrapper();
    client.setQueryData(queryKeys.notifications.unreadCount(), { unread: 1 });
    expect(applyNotificationEvent(client, event(4, 2))).toBe(true);
    expect(client.getQueryData(queryKeys.notifications.inbox())).toBeUndefined();
    expect(client.getQueryData(queryKeys.notifications.unreadCount())).toEqual({ unread: 2 });
    const other = wrapper().client;
    applyNotificationEvent(other, event(4, 2));
    expect(other.getQueryData(queryKeys.notifications.unreadCount())).toEqual({ unread: 2 });
  });
});
