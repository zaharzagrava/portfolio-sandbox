import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSessionPresence } from '@/lib/api/session-presence';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { resetUserStream } from '@/lib/realtime/user-stream';
import { installEventSourceStub, type EventSourceStub } from '@/tests/stubs/event-source';
import { server } from '../../vitest.setup';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const USER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const auth = vi.hoisted(() => ({ signedIn: true }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    user: auth.signedIn ? { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', email: 'a@b.co', role: 'USER' } : null,
    isAuthenticated: auth.signedIn,
    isLoading: false,
  }),
}));

import { NotificationsPopover } from './notifications-popover';

const origin = 'http://localhost:3000';
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
type Item = ReturnType<typeof item>;
const live = (n: number, over: Record<string, unknown> = {}) => {
  const rest = Object.fromEntries(Object.entries(item(n, over)).filter(([key]) => key !== 'read'));
  return { ...rest, unread: true };
};

let es: EventSourceStub;
let countReads = 0;
let listReads = 0;
const serveCount = (unread: () => number) =>
  server.use(
    http.get(`${origin}/api/notifications/unread-count`, () => {
      countReads += 1;
      return HttpResponse.json({ unread: unread() });
    }),
  );
const serveList = (items: () => Item[], nextCursor: string | null = null) =>
  server.use(
    http.get(`${origin}/api/notifications`, () => {
      listReads += 1;
      return HttpResponse.json({ items: items(), nextCursor });
    }),
  );

function renderBell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  render(<NotificationsPopover />, { wrapper });
  return { client };
}

async function openBell(unread: number | null) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: unread ? `Notifications, ${unread} unread` : 'Notifications' }));
  return user;
}

const announcements = () => screen.getAllByRole('status').map((node) => node.textContent ?? '');
const emitNotification = (data: unknown) => act(() => es.last().emit('notification', { topic: `user:${USER}`, data }));

beforeEach(() => {
  auth.signedIn = true;
  countReads = 0;
  listReads = 0;
  toast.success.mockReset();
  toast.error.mockReset();
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

describe('Notifications popover: the bell', () => {
  it('W03 AS-61: the name carries the count, the badge shows it, and the count is read once on mount', async () => {
    serveCount(() => 3);
    renderBell();
    const bell = await screen.findByRole('button', { name: 'Notifications, 3 unread' });
    expect(bell).toHaveTextContent('3');
    expect(countReads).toBe(1);
  });

  it('W03 AS-61: above 99 the badge reads 99+', async () => {
    serveCount(() => 150);
    renderBell();
    expect(await screen.findByRole('button', { name: /^Notifications, / })).toHaveTextContent('99+');
  });

  it('W03 AS-61: at 0 the bell is named "Notifications" and has no badge', async () => {
    serveCount(() => 0);
    renderBell();
    const bell = await screen.findByRole('button', { name: 'Notifications' });
    await waitFor(() => expect(countReads).toBe(1));
    expect(bell).toHaveTextContent('');
  });

  it('W03 AS-61 / AS-65: a count that could not be read leaves the bell without a badge', async () => {
    server.use(http.get(`${origin}/api/notifications/unread-count`, () => HttpResponse.json({ code: 'internal' }, { status: 500 })));
    const { client } = renderBell();
    const bell = await screen.findByRole('button', { name: 'Notifications' });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(bell).toHaveTextContent('');
  });

  it('W03 AS-61: an anonymous visitor sees no bell and nothing is read', async () => {
    auth.signedIn = false;
    serveCount(() => 3);
    renderBell();
    expect(screen.queryByRole('button', { name: /Notifications/ })).toBeNull();
    expect(countReads).toBe(0);
    expect(es.all).toHaveLength(0);
  });

  it('W03 AS-61: the count is read again on tab focus', async () => {
    let count = 1;
    serveCount(() => count);
    renderBell();
    await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    count = 4;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await screen.findByRole('button', { name: 'Notifications, 4 unread' });
    expect(countReads).toBe(2);
  });
});

describe('Notifications popover: the panel', () => {
  it('W03 AS-62: opens a panel titled Notifications, shows a skeleton, then the items newest first with text, <time> and an Unread marker', async () => {
    serveCount(() => 1);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get(`${origin}/api/notifications`, async () => {
        await gate;
        return HttpResponse.json({ items: [item(1, { title: '<b>Order</b> paid' }), item(2, { read: true })], nextCursor: null });
      }),
    );
    renderBell();
    await openBell(1);
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(within(panel).getByRole('heading', { name: 'Notifications' })).toBeInTheDocument();
    expect(within(panel).getByRole('status')).toHaveTextContent('Loading notifications');
    release();
    const rows = await within(panel).findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // plain text: the markup in a title is shown, not applied
    expect(rows[0]).toHaveTextContent('<b>Order</b> paid');
    expect(rows[0].querySelector('b')).toBeNull();
    expect(rows[0]).toHaveTextContent('Body 1');
    expect(within(rows[0]).getByText('Unread')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('Unread')).toBeNull();
    const time = rows[0].querySelector('time');
    expect(time).toHaveAttribute('datetime', '2026-10-11T10:00:00.000Z');
    expect(time?.getAttribute('title')).toMatch(/2026/);
    expect(within(panel).getByRole('list', { name: 'Notifications' })).toBe(rows[0].parentElement);
  });

  it('W03 AS-62: focus moves into the panel, and Esc closes it and returns focus to the bell', async () => {
    serveCount(() => 1);
    serveList(() => [item(1)]);
    renderBell();
    const user = await openBell(1);
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toHaveFocus();
  });

  it('W03 AS-63: activating an unread item marks it read at once, lowers the count and follows the link', async () => {
    let count = 2;
    const posted: unknown[] = [];
    serveCount(() => count);
    serveList(() => [item(1), item(2)]);
    server.use(
      http.post(`${origin}/api/notifications/read`, async ({ request }) => {
        posted.push(await request.json());
        count = 1;
        return HttpResponse.json({ unread: 1 });
      }),
    );
    renderBell();
    const user = await openBell(2);
    const link = await screen.findByRole('link', { name: /Title 1/ });
    expect(link).toHaveAttribute('href', '/orders/1');
    link.addEventListener('click', (event) => event.preventDefault());
    await user.click(link);
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();
    expect(posted).toEqual([{ ids: [id(1)] }]);
  });

  it('W03 AS-63: a failed mark-read rolls the count back and shows an alert toast', async () => {
    serveCount(() => 2);
    serveList(() => [item(1), item(2)]);
    server.use(http.post(`${origin}/api/notifications/read`, () => HttpResponse.json({ code: 'internal' }, { status: 500 })));
    renderBell();
    const user = await openBell(2);
    const link = await screen.findByRole('link', { name: /Title 1/ });
    link.addEventListener('click', (event) => event.preventDefault());
    await user.click(link);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument();
  });

  it('W03 AS-63: a link that is not a same-site path is not a link: the item is plain text', async () => {
    serveCount(() => 1);
    serveList(() => [item(1, { link: 'https://evil.example/x' }), item(2, { link: '//evil.example', read: true }), item(3, { link: 'javascript:alert(1)' }), item(4, { link: null })]);
    renderBell();
    await openBell(1);
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(screen.queryByRole('link')).toBeNull();
    for (const row of rows) expect(within(row).queryByRole('button')).toBeNull();
    expect(screen.getByText('Title 1')).toBeInTheDocument();
  });

  it('W03 AS-64: Mark all as read posts {all: true}, shows every item read, count 0, announces it, and the button goes away', async () => {
    const posted: unknown[] = [];
    serveCount(() => 2);
    serveList(() => [item(1), item(2)]);
    server.use(
      http.post(`${origin}/api/notifications/read`, async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ unread: 0 });
      }),
    );
    renderBell();
    const user = await openBell(2);
    await screen.findAllByRole('listitem');
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(posted).toEqual([{ all: true }]);
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull();
    expect(screen.queryByText('Unread')).toBeNull();
    await waitFor(() => expect(announcements()).toContain('All notifications marked as read'));
  });

  it('W03 AS-64: a failed Mark all as read restores the previous state with an alert toast', async () => {
    serveCount(() => 2);
    serveList(() => [item(1), item(2)]);
    server.use(http.post(`${origin}/api/notifications/read`, () => HttpResponse.json({ code: 'internal' }, { status: 500 })));
    renderBell();
    const user = await openBell(2);
    await screen.findAllByRole('listitem');
    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument();
    expect(screen.getAllByText('Unread')).toHaveLength(2);
    expect(announcements()).not.toContain('All notifications marked as read');
  });

  it('W03 AS-65: an empty inbox says "You\'re all caught up."', async () => {
    serveCount(() => 0);
    serveList(() => []);
    renderBell();
    await openBell(null);
    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument();
  });

  it('W03 AS-65: 429 says when to try again; another failure says so and Try again reads the list again', async () => {
    serveCount(() => 0);
    let mode: 'limited' | 'bad' | 'ok' = 'limited';
    server.use(
      http.get(`${origin}/api/notifications`, () => {
        if (mode === 'limited') return HttpResponse.json({ code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '12' } });
        if (mode === 'bad') return HttpResponse.json({ code: 'validation_failed' }, { status: 400 });
        return HttpResponse.json({ items: [item(1, { read: true })], nextCursor: null });
      }),
    );
    renderBell();
    const user = await openBell(null);
    expect(await screen.findByText('Try again in 12 seconds.')).toBeInTheDocument();
    mode = 'bad';
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText("We couldn't load notifications.")).toBeInTheDocument();
    mode = 'ok';
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Title 1')).toBeInTheDocument();
  });

  it('W03 AS-65: a 401 shows nothing in the list (the session flow takes over hands off to W01)', async () => {
    serveCount(() => 0);
    const ended = vi.fn();
    setSessionEndHandler(ended);
    server.use(http.get(`${origin}/api/notifications`, () => HttpResponse.json({ code: 'unauthenticated' }, { status: 401 })));
    const { client } = renderBell();
    await openBell(null);
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.queryByText("We couldn't load notifications.")).toBeNull();
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('W03 AS-67: Show older appends the next page without duplicates, focus goes to the first new item, and the button goes at the end', async () => {
    const cursors: (string | null)[] = [];
    serveCount(() => 2);
    server.use(
      http.get(`${origin}/api/notifications`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        return cursor
          ? HttpResponse.json({ items: [item(2), item(3, { read: true })], nextCursor: null })
          : HttpResponse.json({ items: [item(1), item(2)], nextCursor: 'c2' });
      }),
    );
    renderBell();
    const user = await openBell(2);
    expect(await screen.findAllByRole('listitem')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(cursors).toEqual([null, 'c2']);
    expect(screen.getAllByRole('listitem').map((row) => row.textContent)).toEqual([expect.stringContaining('Title 1'), expect.stringContaining('Title 2'), expect.stringContaining('Title 3')]);
    await waitFor(() => expect(screen.getAllByRole('listitem')[2].contains(document.activeElement)).toBe(true));
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
  });

  it('W03 AS-69: Tab goes through Mark all as read, the items, then Show older', async () => {
    serveCount(() => 2);
    serveList(() => [item(1), item(2, { link: null })], 'c2');
    renderBell();
    const user = await openBell(2);
    await screen.findAllByRole('listitem');
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    const stops: string[] = [];
    for (let step = 0; step < 3 && panel.contains(document.activeElement); step += 1) {
      stops.push(document.activeElement?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
      await user.tab();
    }
    expect(stops[0]).toBe('Mark all as read');
    expect(stops[1]).toContain('Title 1');
    expect(stops[2]).toBe('Show older');
    // the text-only item is not a tab stop
    expect(stops.some((stop) => stop.includes('Title 2'))).toBe(false);
  });
});

describe('Notifications popover: live', () => {
  it('W03 AS-66: a live notification raises the count, is added on top, is announced once, and a known id is ignored', async () => {
    serveCount(() => 1);
    serveList(() => [item(1)]);
    renderBell();
    await openBell(1);
    await screen.findAllByRole('listitem');
    const trigger = document.activeElement;
    expect(es.last().url).toBe(`/api/streams?topics=user:${USER}`);
    act(() => es.last().open());
    emitNotification(live(9, { title: 'Live one' }));
    expect(await screen.findByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Live one');
    expect(announcements()).toContain('New notification: Live one');
    // the same event again changes nothing
    emitNotification(live(9, { title: 'Live one' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument();
    // focus did not move
    expect(document.activeElement).toBe(trigger);
  });

  it('W03 AS-66: announcements come at most once every 5 seconds', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    serveCount(() => 0);
    serveList(() => []);
    renderBell();
    await screen.findByRole('button', { name: 'Notifications' });
    await waitFor(() => expect(es.all.length).toBeGreaterThan(0));
    act(() => es.last().open());
    emitNotification(live(1, { title: 'First' }));
    now.mockReturnValue(1_002_000);
    emitNotification(live(2, { title: 'Second' }));
    expect(announcements()).toContain('New notification: First');
    expect(announcements().join('|')).not.toContain('Second');
    now.mockReturnValue(1_006_000);
    emitNotification(live(3, { title: 'Third' }));
    expect(announcements()).toContain('New notification: Third');
  });

  it('W03 AS-68: while the stream reconnects the panel header says so, and a reconnect re-reads the count and the first page', async () => {
    let count = 1;
    serveCount(() => count);
    serveList(() => [item(1)]);
    renderBell();
    await openBell(1);
    await screen.findAllByRole('listitem');
    act(() => es.last().open());
    const countBefore = countReads;
    const listBefore = listReads;
    act(() => es.last().fail());
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(await within(panel).findByText('Live updates paused. Reconnecting…')).toBeInTheDocument();
    count = 5;
    act(() => es.last().open());
    await screen.findByRole('button', { name: 'Notifications, 5 unread' });
    expect(countReads).toBeGreaterThan(countBefore);
    expect(listReads).toBeGreaterThan(listBefore);
    await waitFor(() => expect(within(panel).queryByText('Live updates paused. Reconnecting…')).toBeNull());
  });

  it('W03 AS-68: resync re-reads the count and the loaded first page', async () => {
    let count = 1;
    serveCount(() => count);
    serveList(() => [item(1)]);
    renderBell();
    await openBell(1);
    await screen.findAllByRole('listitem');
    act(() => es.last().open());
    const countBefore = countReads;
    const listBefore = listReads;
    count = 3;
    act(() => es.last().emit('resync', { topic: `user:${USER}`, data: { reason: 'gap' } }));
    await screen.findByRole('button', { name: 'Notifications, 3 unread' });
    expect(countReads).toBeGreaterThan(countBefore);
    expect(listReads).toBeGreaterThan(listBefore);
  });

  it('W03 AS-68: revoked is silent: no banner, no alert', async () => {
    serveCount(() => 1);
    serveList(() => [item(1)]);
    renderBell();
    await openBell(1);
    await screen.findAllByRole('listitem');
    act(() => es.last().open());
    act(() => es.last().emit('revoked', { topic: `user:${USER}`, data: {} }));
    expect(screen.queryByText('Live updates paused. Reconnecting…')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
