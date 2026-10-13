import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installEventSourceStub, type EventSourceStub } from '@/tests/stubs/event-source';
import { resetUserStream } from '@/lib/realtime/user-stream';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { setSessionPresence } from '@/lib/api/session-presence';
import { server } from '../vitest.setup';
import { NotificationsPopover } from './notifications-popover';

const USER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const origin = 'http://localhost:3000';

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', email: 'a@b.co', role: 'USER' }, isAuthenticated: true, isLoading: false }) }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  type: 'order.paid',
  category: 'orders',
  title: `Title ${n}`,
  body: `Body ${n}`,
  link: `/orders/${n}`,
  read: false,
  createdAt: '2026-10-11T10:00:00.000Z',
  ...over,
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

let es: EventSourceStub;
const unreadReads = { count: 0 };
const serveCount = (unread: () => number) =>
  server.use(
    http.get(`${origin}/api/notifications/unread-count`, () => {
      unreadReads.count += 1;
      return HttpResponse.json({ unread: unread() });
    }),
  );
const serveList = (items: ReturnType<typeof item>[], nextCursor: string | null = null) =>
  server.use(http.get(`${origin}/api/notifications`, () => HttpResponse.json({ items, nextCursor })));

async function openBell(unread: number | null) {
  const user = userEvent.setup();
  const name = unread ? `Notifications, ${unread} unread` : 'Notifications';
  await user.click(await screen.findByRole('button', { name }));
  return user;
}

describe('NotificationsPopover', () => {
  beforeEach(() => {
    unreadReads.count = 0;
    es = installEventSourceStub();
    rearmSessionEnd();
    setSessionEndHandler(vi.fn());
    setSessionPresence(() => true);
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  });
  afterEach(() => {
    resetUserStream();
    es.restore();
    vi.restoreAllMocks();
  });

  it('S28 AS-55: the list is read from the server, newest first, and Show older appends the next cursor page', async () => {
    const cursors: (string | null)[] = [];
    serveCount(() => 2);
    server.use(
      http.get(`${origin}/api/notifications`, ({ request }) => {
        const url = new URL(request.url);
        cursors.push(url.searchParams.get('cursor'));
        expect(url.searchParams.get('limit')).toBe('20');
        return url.searchParams.get('cursor') ? HttpResponse.json({ items: [item(3, { read: true })], nextCursor: null }) : HttpResponse.json({ items: [item(1), item(2)], nextCursor: 'c2' });
      }),
    );
    const { wrapper } = setup();
    render(<NotificationsPopover />, { wrapper });
    const user = await openBell(2);
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map((row) => within(row).getByText(/^Title/).textContent)).toEqual(['Title 1', 'Title 2']);
    await user.click(screen.getByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(cursors).toEqual([null, 'c2']);
    expect(screen.queryByRole('button', { name: 'Show older' })).not.toBeInTheDocument();
  });

  it('S28 AS-57: the badge shows the server count and is hidden when the count could not be read', async () => {
    serveCount(() => 3);
    const first = setup();
    const view = render(<NotificationsPopover />, { wrapper: first.wrapper });
    expect(await screen.findByRole('button', { name: 'Notifications, 3 unread' })).toHaveTextContent('3');
    view.unmount();
    resetUserStream();
    server.use(http.get(`${origin}/api/notifications/unread-count`, () => HttpResponse.json({ code: 'internal' }, { status: 500 })));
    const second = setup();
    render(<NotificationsPopover />, { wrapper: second.wrapper });
    const bell = await screen.findByRole('button', { name: 'Notifications' });
    await waitFor(() => expect(second.client.isFetching()).toBe(0));
    expect(bell).toHaveTextContent('');
  });

  it('S28 AS-58: opening an unread item marks it read, lowers the badge and follows the relative link', async () => {
    let count = 2;
    const posted: unknown[] = [];
    serveCount(() => count);
    serveList([item(1), item(2)]);
    server.use(
      http.post(`${origin}/api/notifications/read`, async ({ request }) => {
        posted.push(await request.json());
        count = 1;
        return HttpResponse.json({ unread: 1 });
      }),
    );
    const { wrapper } = setup();
    render(<NotificationsPopover />, { wrapper });
    const user = await openBell(2);
    const link = await screen.findByRole('link', { name: /Title 1/ });
    expect(link).toHaveAttribute('href', '/orders/1');
    link.addEventListener('click', (event) => event.preventDefault());
    await user.click(link);
    await waitFor(() => expect(posted).toEqual([{ ids: [id(1)] }]));
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();
  });

  it('S28 AS-66: a link that is not a same-site path is not followed: the item is plain text in a button', async () => {
    serveCount(() => 1);
    serveList([item(1, { link: 'https://evil.example/x' }), item(2, { link: '//evil.example', read: true })]);
    const { wrapper } = setup();
    render(<NotificationsPopover />, { wrapper });
    await openBell(1);
    await screen.findAllByRole('listitem');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Title 1/ })).toBeInTheDocument();
  });

  it('S28 AS-60: Mark all read posts {all: true} and takes the badge away at once', async () => {
    const posted: unknown[] = [];
    serveCount(() => 2);
    serveList([item(1), item(2)]);
    server.use(
      http.post(`${origin}/api/notifications/read`, async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ unread: 0 });
      }),
    );
    const { wrapper } = setup();
    render(<NotificationsPopover />, { wrapper });
    const user = await openBell(2);
    await screen.findAllByRole('listitem');
    await user.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(posted).toEqual([{ all: true }]);
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
    for (const row of screen.getAllByRole('listitem')) expect(row).toHaveAttribute('data-read', 'true');
  });

  it('S28 AS-01: a live `notification` event on user:<id> adds the item on top and raises the badge', async () => {
    serveCount(() => 1);
    serveList([item(1)]);
    const { wrapper } = setup();
    render(<NotificationsPopover />, { wrapper });
    await openBell(1);
    await screen.findAllByRole('listitem');
    expect(es.last().url).toBe(`/api/streams?topics=user:${USER}`);
    act(() => es.last().open());
    act(() => es.last().emit('notification', { topic: `user:${USER}`, data: { ...item(9, { title: 'Live one' }), read: undefined, unread: true } }));
    expect(await screen.findByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Live one');
    // the same event again (replay) changes nothing
    act(() => es.last().emit('notification', { topic: `user:${USER}`, data: { ...item(9, { title: 'Live one' }), read: undefined, unread: true } }));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('S28 AS-01: the count is read again on window focus and when the stream reconnects', async () => {
    let count = 1;
    serveCount(() => count);
    serveList([]);
    const { wrapper } = setup();
    render(<NotificationsPopover />, { wrapper });
    await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    expect(unreadReads.count).toBe(1);
    count = 4;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await screen.findByRole('button', { name: 'Notifications, 4 unread' });
    expect(unreadReads.count).toBe(2);
    count = 6;
    act(() => es.last().open());
    act(() => es.last().fail());
    act(() => es.last().open());
    await screen.findByRole('button', { name: 'Notifications, 6 unread' });
    expect(unreadReads.count).toBe(3);
  });

  it('S28 AS-56: 429 says when to try again; any other failure says so briefly and Try again reads the list again', async () => {
    serveCount(() => 0);
    let mode: 'limited' | 'bad' | 'ok' = 'limited';
    server.use(
      http.get(`${origin}/api/notifications`, () => {
        if (mode === 'limited') return HttpResponse.json({ code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '12' } });
        if (mode === 'bad') return HttpResponse.json({ code: 'validation_failed' }, { status: 400 });
        return HttpResponse.json({ items: [item(1, { read: true })], nextCursor: null });
      }),
    );
    const { wrapper } = setup();
    render(<NotificationsPopover />, { wrapper });
    const user = await openBell(null);
    expect(await screen.findByText('Try again in 12 seconds.')).toBeInTheDocument();
    mode = 'bad';
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText("We couldn't load notifications.")).toBeInTheDocument();
    mode = 'ok';
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Title 1')).toBeInTheDocument();
  });

  it('S28 AS-56: a 401 shows nothing in the list (the session flow takes over)', async () => {
    serveCount(() => 0);
    server.use(http.get(`${origin}/api/notifications`, () => HttpResponse.json({ code: 'unauthenticated' }, { status: 401 })));
    const { wrapper, client } = setup();
    render(<NotificationsPopover />, { wrapper });
    await openBell(null);
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.queryByText("We couldn't load notifications.")).not.toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });
});
