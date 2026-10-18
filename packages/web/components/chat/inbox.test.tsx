import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CH1, CH2, CH3, chatClient, inboxItem, inboxPage, problemBody, renderChat, mockChatRoutes } from '@/tests/support/chat-fixtures';
import { queryKeys } from '@/lib/query-keys';
import { server } from '../../vitest.setup';
import { Inbox } from './inbox';

const NOW = new Date(2026, 9, 17, 15, 30, 0);

const rows = () => within(screen.getByRole('navigation', { name: 'Your chats' })).getAllByRole('link');

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW }));
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('Chat inbox', () => {
  it('W05 AS-07: each chat is a link to ?channel= with title, time, Archived tag and the unread badge, in the order the API gave', async () => {
    mockChatRoutes({
      inbox: () =>
        inboxPage([
          inboxItem({ id: CH1, title: 'Espresso Machine', unread: 3, lastMessageAt: new Date(NOW.getTime() - 2 * 60_000).toISOString() }),
          inboxItem({ id: CH2, title: 'Desk Lamp', unread: 150, lastMessageAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() }),
          inboxItem({ id: CH3, title: 'Old Chair', unread: 0, isArchived: true, lastMessageAt: new Date(2026, 8, 1, 9, 0).toISOString() }),
        ]),
    });
    renderChat(<Inbox openId={CH2} />);
    expect(await screen.findByRole('link', { name: /Espresso Machine/ })).toHaveAttribute('href', `/chat?channel=${CH1}`);
    const links = rows();
    expect(links.map((link) => link.getAttribute('href'))).toEqual([`/chat?channel=${CH1}`, `/chat?channel=${CH2}`, `/chat?channel=${CH3}`]);
    expect(links[0]).toHaveTextContent('2 min ago');
    expect(within(links[0]!).getByText('3 unread messages')).toBeInTheDocument();
    expect(within(links[0]!).getByText('3')).toBeInTheDocument();
    expect(within(links[1]!).getByText('99+')).toBeInTheDocument();
    expect(within(links[1]!).getByText('150 unread messages')).toBeInTheDocument();
    expect(within(links[2]!).getByText('Archived')).toBeInTheDocument();
    expect(within(links[2]!).queryByText(/unread/)).not.toBeInTheDocument();
    // Only the open chat's row is the current page.
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([null, 'page', null]);
  });

  it('W05 AS-07: one unread message has the singular name', async () => {
    mockChatRoutes({ inbox: () => inboxPage([inboxItem({ unread: 1 })]) });
    renderChat(<Inbox openId={null} />);
    expect(await screen.findByText('1 unread message')).toBeInTheDocument();
  });

  it('W05 AS-08: while loading it shows a busy skeleton and a status', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get('http://localhost:3000/api/chat/channels/mine', async () => {
        await gate;
        return HttpResponse.json(inboxPage([inboxItem()]));
      }),
    );
    renderChat(<Inbox openId={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading chats…');
    expect(screen.getByRole('navigation', { name: 'Your chats' })).toHaveAttribute('aria-busy', 'true');
    await act(async () => release());
    expect(await screen.findByRole('link', { name: /Espresso Machine/ })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Your chats' })).not.toHaveAttribute('aria-busy', 'true');
  });

  it('W05 AS-08: no chats shows the empty copy and a Browse products link', async () => {
    mockChatRoutes({ inbox: () => inboxPage([]) });
    renderChat(<Inbox openId={null} />);
    expect(await screen.findByText('No chats yet. Open a product and press Chat with seller.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse products' })).toHaveAttribute('href', '/search');
  });

  it('W05 AS-08: a failed first read shows the error with the reference and Try again, which reads again', async () => {
    let fail = true;
    mockChatRoutes({ inbox: () => (fail ? problemBody(503, 'service_unavailable') : inboxPage([inboxItem()])) });
    renderChat(<Inbox openId={null} />);
    expect(await screen.findByText("We couldn't load your chats.")).toBeInTheDocument();
    expect(screen.getByText('Reference: req-1')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /Espresso Machine/ })).toBeInTheDocument();
    expect(screen.queryByText("We couldn't load your chats.")).not.toBeInTheDocument();
  });

  it('W05 AS-08: a failed later refresh keeps the rows and shows only a quiet "Couldn\'t refresh" status that clears on success', async () => {
    let fail = false;
    mockChatRoutes({ inbox: () => (fail ? problemBody(500, 'internal') : inboxPage([inboxItem({ unread: 2 })])) });
    const { client } = renderChat(<Inbox openId={null} />);
    expect(await screen.findByRole('link', { name: /Espresso Machine/ })).toBeInTheDocument();
    fail = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.chat.inbox() });
    });
    expect(await screen.findByText("Couldn't refresh")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Espresso Machine/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fail = false;
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.chat.inbox() });
    });
    await waitFor(() => expect(screen.queryByText("Couldn't refresh")).not.toBeInTheDocument());
  });

  it('W05 AS-09: Show more chats appends the next page without reordering the rows already shown, then disappears at nextCursor null', async () => {
    const cursors: (string | null)[] = [];
    mockChatRoutes({
      inbox: (cursor) => {
        cursors.push(cursor);
        return cursor
          ? inboxPage([inboxItem({ id: CH3, title: 'Third' })])
          : inboxPage([inboxItem({ id: CH1, title: 'First' }), inboxItem({ id: CH2, title: 'Second' })], 'next-1');
      },
    });
    renderChat(<Inbox openId={null} />);
    const more = await screen.findByRole('button', { name: 'Show more chats' });
    expect(rows()).toHaveLength(2);
    await userEvent.click(more);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().map((link) => link.getAttribute('href'))).toEqual([`/chat?channel=${CH1}`, `/chat?channel=${CH2}`, `/chat?channel=${CH3}`]);
    expect(cursors).toContain('next-1');
    expect(screen.queryByRole('button', { name: 'Show more chats' })).not.toBeInTheDocument();
  });

  describe('keeping it current (AS-10)', () => {
    async function open() {
      const calls = mockChatRoutes({ inbox: () => inboxPage([inboxItem({ unread: 1 })]) });
      const view = renderChat(<Inbox openId={null} />);
      await screen.findByRole('link', { name: /Espresso Machine/ });
      return { calls, ...view };
    }

    it('W05 AS-10: it is read again when the window regains focus', async () => {
      const { calls } = await open();
      expect(calls.inbox).toBe(1);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() => expect(calls.inbox).toBe(2));
    });

    it('W05 AS-10: it is read again when the tab becomes visible', async () => {
      const { calls } = await open();
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(calls.inbox).toBe(1);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitFor(() => expect(calls.inbox).toBe(2));
    });

    it('W05 AS-10: it is read every 30 seconds while visible', async () => {
      const { calls } = await open();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await waitFor(() => expect(calls.inbox).toBe(2));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await waitFor(() => expect(calls.inbox).toBe(3));
    });

    it('W05 AS-10: a background tab does not poll', async () => {
      const { calls } = await open();
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(calls.inbox).toBe(1);
    });

    it('W05 AS-10: invalidating the inbox key (after a send, a live hint, a reconnect) reads it again', async () => {
      const { calls, client } = await open();
      await act(async () => {
        await client.invalidateQueries({ queryKey: queryKeys.chat.inbox() });
      });
      expect(calls.inbox).toBe(2);
    });
  });

  it('W05 AS-07: rows come from the hydrated first page without a request', async () => {
    const client = chatClient();
    client.setQueryData(queryKeys.chat.inbox(), { pages: [inboxPage([inboxItem({ title: 'Hydrated' })])], pageParams: [undefined] });
    const calls = mockChatRoutes({ inbox: () => inboxPage([]) });
    renderChat(<Inbox openId={null} />, { client });
    expect(screen.getByRole('link', { name: /Hydrated/ })).toBeInTheDocument();
    expect(calls.inbox).toBe(0);
  });
});
