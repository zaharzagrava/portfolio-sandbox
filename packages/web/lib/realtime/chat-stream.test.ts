import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatChannelSync, ChatInboxItem, ChatMessage } from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import type { UserStreamSnapshot } from '@/lib/realtime/user-stream';
import { createFakeLive, type FakeLive } from '@/tests/support/fake-live';

type SnapshotShape = UserStreamSnapshot;
import { CH1, CH2, CH3, ME, ORIGIN, SELLER, channel, historyPage, inboxItem, inboxPage, message, problemBody, renderChat, mockChatRoutes, uuid } from '@/tests/support/chat-fixtures';
import { server } from '../../vitest.setup';
import { BACKOFF_STEPS_MS } from '@/lib/chat/backoff';
import { channelOfTopic, chatTopic, selectTopics } from './chat-topics';

const live = vi.hoisted(() => ({
  fake: null as FakeLive | null,
  snapshot: { health: 'connected', poll: 'idle', bannerOwner: null, showBanner: false } as SnapshotShape,
  listeners: new Set<() => void>(),
}));
vi.mock('@/lib/realtime/user-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/realtime/user-stream')>();
  return {
    ...actual,
    subscribeTopic: (...args: Parameters<typeof actual.subscribeTopic>) => live.fake!.subscribeTopic(...args),
    getUserStreamSnapshot: () => live.snapshot,
    subscribeUserStreamState: (listener: () => void) => {
      live.listeners.add(listener);
      return () => live.listeners.delete(listener);
    },
  };
});
const navigation = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => navigation.search, useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

import { ChatShell } from '@/components/chat/chat-shell';

const setHealth = (health: SnapshotShape['health']) =>
  act(() => {
    live.snapshot = { ...live.snapshot, health, showBanner: health === 'reconnecting' };
    live.listeners.forEach((listener) => listener());
  });
const setOnline = (online: boolean) =>
  act(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
const setVisible = (visible: boolean) =>
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: visible ? 'visible' : 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

type Setup = { inbox?: ChatInboxItem[]; history?: ChatMessage[]; sync?: (cursors: Record<string, number>, call: number) => ChatChannelSync[] | Response | Promise<ChatChannelSync[] | Response> };
const syncCalls: Record<string, number>[] = [];

function mount(setup: Setup = {}) {
  syncCalls.length = 0;
  navigation.search = new URLSearchParams({ channel: CH1 });
  const calls = mockChatRoutes({
    inbox: () => inboxPage(setup.inbox ?? [inboxItem({ id: CH1 })]),
    channel: () => channel({ id: CH1 }),
    history: () => historyPage(setup.history ?? [message(1), message(2)]),
  });
  server.use(
    // `online` makes the session read again (W01): it still answers with the member.
    http.get(`${ORIGIN}/api/bff/session`, () => HttpResponse.json({ user: { id: ME, email: 'me@example.com', role: 'USER' }, expiresAt: '2030-01-01T00:00:00.000Z' })),
    http.post(`${ORIGIN}/api/chat/sync`, async ({ request }) => {
      const { cursors } = (await request.json()) as { cursors: Record<string, number> };
      syncCalls.push(cursors);
      const answer = setup.sync ? await setup.sync(cursors, syncCalls.length) : [];
      return answer instanceof Response ? answer : HttpResponse.json(answer);
    }),
  );
  const view = renderChat(createElement(ChatShell), { user: { id: ME } });
  return { calls, ...view };
}

const syncOf = (seqs: number[], over: Partial<ChatMessage> = {}, hasMore = false): ChatChannelSync[] => [
  { channelId: CH1, messages: seqs.map((seq) => message(seq, over)), lastSeq: Math.max(...seqs), hasMore },
];
const bodies = () => screen.queryAllByTestId('chat-message').map((node) => node.textContent ?? '');
const hint = (seq: number, topic = chatTopic(CH1)) => act(() => live.fake!.emit(topic, 'message', { channelId: CH1, messageId: uuid(seq), seq }));
const ready = () => screen.findByRole('list', { name: 'Messages in Espresso Machine' });

beforeEach(() => {
  live.fake = createFakeLive();
  live.snapshot = { health: 'connected', poll: 'idle', bannerOwner: null, showBanner: false };
  live.listeners.clear();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe('Chat live connection', () => {
  describe('topics (FR-040)', () => {
    const item = (n: number, at: string | null, over: Partial<ChatInboxItem> = {}) => inboxItem({ id: uuid(n), lastMessageAt: at, ...over });

    it('W05 AS-23: the open chat plus the 8 chats with the latest activity, sorted so an unchanged set is an equal list', () => {
      const items = Array.from({ length: 12 }, (_, n) => item(n + 1, new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString()));
      const topics = selectTopics(uuid(1), items);
      expect(topics).toHaveLength(9);
      expect(topics).toEqual([...topics].sort());
      expect(topics).toContain(chatTopic(uuid(1)));
      // The 8 newest others are 12..5; the oldest ones are left to the inbox refresh.
      for (const n of [12, 11, 10, 9, 8, 7, 6, 5]) expect(topics).toContain(chatTopic(uuid(n)));
      expect(topics).not.toContain(chatTopic(uuid(2)));
      expect(selectTopics(uuid(1), [...items].reverse())).toEqual(topics);
    });

    it('W05 AS-23: archived chats and the open chat\'s inbox row add nothing extra; with no open chat only the latest 8 are listened to', () => {
      const items = [item(1, '2026-10-01T00:00:00.000Z'), item(2, '2026-10-02T00:00:00.000Z', { isArchived: true }), item(3, null)];
      expect(selectTopics(uuid(1), items)).toEqual([chatTopic(uuid(1)), chatTopic(uuid(3))].sort());
      expect(selectTopics(null, items)).toEqual([chatTopic(uuid(1)), chatTopic(uuid(3))].sort());
      expect(selectTopics(uuid(9), [])).toEqual([chatTopic(uuid(9))]);
    });

    it('W05 AS-23: topic names map back to their channel id', () => {
      expect(channelOfTopic(chatTopic(CH1))).toBe(CH1);
      expect(channelOfTopic(`user:${ME}`)).toBeNull();
    });

    it('W05 AS-23: the page listens to the open chat and the latest others, asking for the hint, read and presence events', async () => {
      mount({ inbox: [inboxItem({ id: CH1 }), inboxItem({ id: CH2, lastMessageAt: '2026-10-02T00:00:00.000Z' }), inboxItem({ id: CH3, lastMessageAt: '2026-10-03T00:00:00.000Z' })] });
      await ready();
      await waitFor(() => expect(live.fake!.held()).toEqual([chatTopic(CH1), chatTopic(CH2), chatTopic(CH3)].sort()));
      expect(live.fake!.typesOf(chatTopic(CH1)).sort()).toEqual(['channel_archived', 'message', 'message_deleted', 'presence', 'read']);
    });

    it('W05 AS-23: a new chat in the inbox adds one topic and leaves the others as they were (no reconnect of unchanged topics)', async () => {
      const view = mount();
      await ready();
      await waitFor(() => expect(live.fake!.held()).toEqual([chatTopic(CH1)]));
      server.use(http.get(`${ORIGIN}/api/chat/channels/mine`, () => HttpResponse.json(inboxPage([inboxItem({ id: CH1 }), inboxItem({ id: CH2, lastMessageAt: '2026-10-05T00:00:00.000Z' })]))));
      await act(async () => {
        await view.client.invalidateQueries({ queryKey: queryKeys.chat.inbox() });
      });
      await waitFor(() => expect(live.fake!.held()).toEqual([chatTopic(CH1), chatTopic(CH2)].sort()));
      expect(live.fake!.subscribed().filter((topic) => topic === chatTopic(CH1))).toHaveLength(1);
    });
  });

  describe('hints (AS-23, AS-25)', () => {
    it('W05 AS-23: a message hint runs one sync and the message appears once; the hint\'s payload is never rendered', async () => {
      mount({ sync: () => syncOf([3], { body: 'from sync', authorId: SELLER }) });
      await ready();
      hint(3);
      await waitFor(() => expect(bodies().some((text) => text.includes('from sync'))).toBe(true));
      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0]).toEqual({ [CH1]: 2 });
      expect(bodies().filter((text) => text.includes('from sync'))).toHaveLength(1);
      hint(3);
      await advance(50);
      expect(bodies().filter((text) => text.includes('from sync'))).toHaveLength(1);
    });

    it('W05 AS-25: hints that arrive while a sync runs share it, and exactly one more run follows', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      mount({
        sync: async (_, call) => {
          if (call === 1) await gate;
          return [];
        },
      });
      await ready();
      hint(3);
      hint(4);
      hint(5);
      await advance(100);
      expect(syncCalls).toHaveLength(1);
      await act(async () => release());
      await waitFor(() => expect(syncCalls).toHaveLength(2));
      await advance(100);
      expect(syncCalls).toHaveLength(2);
    });

    it('W05 AS-23: a new message from another member is announced once as "{author}: {text}" (own messages never)', async () => {
      mount({ sync: (_, call) => (call === 1 ? syncOf([3], { body: 'Is it available?', authorId: SELLER }) : syncOf([4], { body: 'my own', authorId: ME })) });
      await ready();
      hint(3);
      expect(await screen.findByText('Seller: Is it available?', { selector: '[role="status"]' })).toBeInTheDocument();
      await advance(1500);
      hint(4);
      await waitFor(() => expect(bodies().some((text) => text.includes('my own'))).toBe(true));
      await advance(1500);
      expect(screen.queryByText('Seller: my own')).not.toBeInTheDocument();
      expect(screen.queryByText('You: my own')).not.toBeInTheDocument();
    });

    it('W05 AS-23: announcements come at most one a second and are coalesced into one', async () => {
      mount({ sync: (_, call) => syncOf(call === 1 ? [3] : [4, 5], { authorId: SELLER, body: `news ${call}` }) });
      await ready();
      hint(3);
      await screen.findByText('Seller: news 1', { selector: '[role="status"]' });
      hint(4);
      await waitFor(() => expect(syncCalls).toHaveLength(2));
      // Still inside the second after the first announcement: not spoken yet.
      expect(screen.queryByText(/2 new messages/)).not.toBeInTheDocument();
      await advance(1100);
      expect(screen.getByText('2 new messages. Seller: news 2', { selector: '[role="status"]' })).toBeInTheDocument();
    });

    it('W05 AS-23: without any hint the open chat is still synced every 15 seconds while the tab is visible', async () => {
      mount({ sync: () => syncOf([3], { authorId: SELLER, body: 'quiet arrival' }) });
      await ready();
      await advance(14_000);
      expect(syncCalls).toHaveLength(0);
      await advance(1_500);
      await waitFor(() => expect(syncCalls).toHaveLength(1));
      await waitFor(() => expect(bodies().some((text) => text.includes('quiet arrival'))).toBe(true));
    });

    it('W05 AS-20: a deletion hint turns the message into the tombstone; an archive hint flips the composer', async () => {
      mount();
      await ready();
      act(() => live.fake!.emit(chatTopic(CH1), 'message_deleted', { channelId: CH1, messageId: message(2).id }));
      await waitFor(() => expect(bodies()[1]).toContain('Message removed'));
      act(() => live.fake!.emit(chatTopic(CH1), 'channel_archived', { channelId: CH1 }));
      expect(await screen.findByText('This chat was archived. You can read it, but not reply.')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    });
  });

  describe('a lost connection (AS-24)', () => {
    it('W05 AS-24: after 3 seconds without a connection the banner "Reconnecting…" appears, and the open chat is synced every 5 seconds meanwhile', async () => {
      mount({ sync: () => [] });
      await ready();
      await setHealth('reconnecting');
      await advance(2_900);
      expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
      await advance(200);
      expect(screen.getByText('Reconnecting…')).toHaveAttribute('role', 'status');
      const before = syncCalls.length;
      await advance(5_100);
      expect(syncCalls.length).toBeGreaterThan(before);
      // The composer keeps working.
      expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
    });

    it('W05 AS-24: when the connection is open again the banner goes only after a full catch-up has completed, with nothing missing or doubled', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      mount({
        sync: async () => {
          await gate;
          return syncOf([3, 4], { authorId: SELLER, body: 'while you were away' });
        },
      });
      await ready();
      await setHealth('reconnecting');
      await advance(3_100);
      expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
      await setHealth('connected');
      await waitFor(() => expect(syncCalls.length).toBeGreaterThanOrEqual(1));
      await advance(200);
      expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
      await act(async () => release());
      await waitFor(() => expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument());
      expect(bodies().filter((text) => text.includes('while you were away'))).toHaveLength(2);
    });

    it('W05 AS-24: a catch-up that fails keeps the banner until a later one succeeds', async () => {
      mount({ sync: (_, call) => (call === 1 ? problemBody(503, 'service_unavailable') : []) });
      await ready();
      await setHealth('reconnecting');
      await advance(3_100);
      await setHealth('connected');
      await waitFor(() => expect(syncCalls.length).toBeGreaterThanOrEqual(1));
      await advance(100);
      expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
      await advance(16_000);
      await waitFor(() => expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument());
    });
  });

  describe('resync and revoked (AS-26, AS-27)', () => {
    it('W05 AS-26: resync re-reads the newest page and the inbox, runs the catch-up and replaces what is held, without any error', async () => {
      let page = [message(1), message(2)];
      const view = mount();
      let receiptReads = 0;
      server.use(
        http.get(`${ORIGIN}/api/chat/channels/:id/messages`, () => HttpResponse.json(historyPage(page))),
        http.get(`${ORIGIN}/api/chat/channels/${CH1}/receipts`, () => {
          receiptReads += 1;
          return HttpResponse.json({ items: [], suppressed: false });
        }),
      );
      await ready();
      expect(bodies()).toHaveLength(2);
      await waitFor(() => expect(receiptReads).toBe(1));
      page = [message(1), message(3, { body: 'after the gap' })]; // message 2 was deleted, 3 arrived
      const inboxBefore = view.calls.inbox;
      act(() => live.fake!.resync());
      await waitFor(() => expect(bodies().some((text) => text.includes('after the gap'))).toBe(true));
      expect(bodies().some((text) => text.includes('message 2'))).toBe(false);
      expect(view.calls.inbox).toBeGreaterThan(inboxBefore);
      await waitFor(() => expect(receiptReads).toBe(2)); // FR-044: the starting positions are read again after a resync
      expect(syncCalls.length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('W05 AS-27: revoked drops the topic; a chat that answers 403 shows the unavailable state and leaves the inbox', async () => {
      mount({ inbox: [inboxItem({ id: CH1 }), inboxItem({ id: CH2, title: 'Other chat' })] });
      await ready();
      await waitFor(() => expect(live.fake!.held()).toContain(chatTopic(CH1)));
      server.use(http.get(`${ORIGIN}/api/chat/channels/${CH1}`, () => problemBody(403, 'permission_denied')));
      act(() => live.fake!.revoked(chatTopic(CH1)));
      expect(live.fake!.held()).not.toContain(chatTopic(CH1));
      expect(await screen.findByText("This chat isn't available.")).toBeInTheDocument();
      const nav = screen.getByRole('navigation', { name: 'Your chats' });
      await waitFor(() => expect(within(nav).queryByRole('link', { name: /Espresso Machine/ })).not.toBeInTheDocument());
      expect(live.fake!.held()).not.toContain(chatTopic(CH1));
    });

    it('W05 AS-27: a chat that still answers 200 is subscribed again, once', async () => {
      mount();
      await ready();
      await waitFor(() => expect(live.fake!.held()).toEqual([chatTopic(CH1)]));
      act(() => live.fake!.revoked(chatTopic(CH1)));
      await waitFor(() => expect(live.fake!.held()).toEqual([chatTopic(CH1)]));
      expect(live.fake!.subscribed().filter((topic) => topic === chatTopic(CH1))).toHaveLength(2);
      act(() => live.fake!.revoked(chatTopic(CH1)));
      await advance(200);
      expect(live.fake!.held()).toEqual([]);
      expect(live.fake!.subscribed().filter((topic) => topic === chatTopic(CH1))).toHaveLength(2);
    });
  });

  describe('a refused stream is recreated (AS-28)', () => {
    it('W05 AS-28: a connection closed for good is recreated after 1, 2, 4 seconds (+-20 %) while the banner and the 5 s polling cover the gap', async () => {
      mount();
      await ready();
      await setHealth('closed');
      const base = live.fake!.subscribed().length;
      await advance(BACKOFF_STEPS_MS[0] * 0.8 - 100);
      expect(live.fake!.subscribed().length).toBe(base);
      await advance(BACKOFF_STEPS_MS[0] * 0.4 + 200);
      expect(live.fake!.subscribed().length).toBe(base + 1);
      await advance(BACKOFF_STEPS_MS[1] * 1.2 + 200);
      expect(live.fake!.subscribed().length).toBe(base + 2);
      expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    });

    it('W05 AS-28: once the connection has been open the attempts start again from 1 second', async () => {
      mount();
      await ready();
      await setHealth('closed');
      await advance(BACKOFF_STEPS_MS[0] * 1.2 + 100);
      await setHealth('connected');
      await advance(31_000);
      const base = live.fake!.subscribed().length;
      await setHealth('closed');
      await advance(BACKOFF_STEPS_MS[0] * 1.2 + 100);
      expect(live.fake!.subscribed().length).toBe(base + 1);
    });
  });

  it('W05 AS-40: when the session ends the page stops listening (no topic stays held) and nothing is recreated', async () => {
    const view = mount();
    await ready();
    await waitFor(() => expect(live.fake!.held()).toEqual([chatTopic(CH1)]));
    act(() => {
      view.client.setQueryData(queryKeys.auth.session(), null);
    });
    await waitFor(() => expect(live.fake!.held()).toEqual([]));
    await setHealth('closed');
    await advance(40_000);
    expect(live.fake!.held()).toEqual([]);
  });

  describe('offline and background tabs (AS-29)', () => {
    it('W05 AS-29: offline shows the offline banner, polls nothing; online catches up at once and clears the banner after it', async () => {
      mount({ sync: () => [] });
      await ready();
      await setOnline(false);
      expect(await screen.findByText("You're offline. Messages will send when you're back online.")).toHaveAttribute('role', 'status');
      await advance(60_000);
      expect(syncCalls).toHaveLength(0);
      await setOnline(true);
      await waitFor(() => expect(syncCalls).toHaveLength(1));
      await waitFor(() => expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument());
    });

    it('W05 AS-29: a hidden tab polls nothing; when it becomes visible the catch-up runs at once', async () => {
      mount({ sync: () => [] });
      await ready();
      await setVisible(false);
      await advance(60_000);
      expect(syncCalls).toHaveLength(0);
      await setVisible(true);
      await waitFor(() => expect(syncCalls).toHaveLength(1));
    });
  });
});
