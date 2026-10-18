import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMessages, type MessagesData } from '@/lib/chat/message-cache';
import { queryKeys } from '@/lib/query-keys';
import { installIntersectionObserver, type IntersectionControl } from '@/tests/support/intersection-observer';
import { virtuosoCalls } from '@/tests/support/virtuoso-double';
import { CH1, ME, ORIGIN, SELLER, channel, chatClient, historyPage, inboxItem, inboxPage, message, mockChatRoutes, problemBody, renderChat } from '@/tests/support/chat-fixtures';
import { server } from '../../vitest.setup';
import { Conversation } from './conversation';

let io: IntersectionControl;
let focused = true;
const reads: { seq: number }[] = [];
let readAnswer: (call: number, seq: number) => Response = (_, seq) => HttpResponse.json({ lastReadSeq: seq, unread: 0 });

function open(history = [message(1), message(2), message(3)], unread = 3) {
  const client = chatClient({ id: ME });
  client.setQueryData(queryKeys.chat.inbox(), { pages: [inboxPage([inboxItem({ id: CH1, unread, lastSeq: 3 })])], pageParams: [undefined] });
  mockChatRoutes({ channel: () => channel(), history: () => historyPage(history) });
  server.use(
    http.post(`${ORIGIN}/api/chat/channels/${CH1}/read`, async ({ request }) => {
      const { seq } = (await request.json()) as { seq: number };
      reads.push({ seq });
      return readAnswer(reads.length, seq);
    }),
  );
  return renderChat(<Conversation channelId={CH1} drafts={new Map()} />, { client });
}

const rows = () => screen.getAllByTestId('chat-message');
const ready = () => screen.findByRole('list', { name: 'Messages in Espresso Machine' });
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const inboxUnread = (client: ReturnType<typeof chatClient>) => (client.getQueryData(queryKeys.chat.inbox()) as { pages: { items: { unread: number }[] }[] }).pages[0]!.items[0]!.unread;
const setTabState = (visible: boolean, hasFocus: boolean) =>
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: visible ? 'visible' : 'hidden' });
    focused = hasFocus;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(hasFocus ? 'focus' : 'blur'));
  });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  io = installIntersectionObserver();
  reads.length = 0;
  focused = true;
  readAnswer = (_, seq) => HttpResponse.json({ lastReadSeq: seq, unread: 0 });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  virtuosoCalls.reset();
});
afterEach(() => {
  io.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Read tracker', () => {
  it('W05 AS-31: a message that is in view is marked read after a 500 ms debounce, with the highest seq in view, and the badge is set from the answer', async () => {
    readAnswer = (_, seq) => HttpResponse.json({ lastReadSeq: seq, unread: 1 });
    const { client } = open();
    await ready();
    act(() => {
      io.show(rows()[1]!);
      io.show(rows()[2]!);
    });
    await advance(400);
    expect(reads).toHaveLength(0);
    await advance(200);
    await waitFor(() => expect(reads).toEqual([{ seq: 3 }]));
    // The number is the server's, not a guess: it says 1 still unread.
    await waitFor(() => expect(inboxUnread(client)).toBe(1));
  });

  it('W05 AS-31: only messages whose bottom edge is in view count; one that is cut off at the bottom does not', async () => {
    open();
    await ready();
    act(() => {
      io.show(rows()[0]!);
      io.showTopOnly(rows()[1]!);
    });
    await advance(700);
    await waitFor(() => expect(reads).toEqual([{ seq: 1 }]));
  });

  it('W05 AS-31: nothing is marked while the tab is hidden or the window is not focused; it is marked when the reader is back', async () => {
    open();
    await ready();
    await setTabState(false, false);
    act(() => io.show(rows()[2]!));
    await advance(2_000);
    expect(reads).toHaveLength(0);
    await setTabState(true, false);
    await advance(2_000);
    expect(reads).toHaveLength(0);
    await setTabState(true, true);
    await advance(700);
    await waitFor(() => expect(reads).toEqual([{ seq: 3 }]));
  });

  it('W05 AS-31: a position already acknowledged is never sent again, and never a lower one', async () => {
    open();
    await ready();
    act(() => io.show(rows()[2]!));
    await advance(700);
    await waitFor(() => expect(reads).toHaveLength(1));
    act(() => {
      io.hide(rows()[2]!);
      io.show(rows()[1]!);
    });
    await advance(1_000);
    act(() => io.show(rows()[2]!));
    await advance(1_000);
    expect(reads).toEqual([{ seq: 3 }]);
  });

  it('W05 AS-31: the member\'s own messages mark nothing, and neither does sending one', async () => {
    open([message(1, { authorId: SELLER }), message(2, { authorId: ME, body: 'mine' })], 0);
    await ready();
    act(() => io.show(rows()[1]!));
    await advance(1_000);
    expect(reads).toHaveLength(0);
    expect(io.observed().map((element) => element.textContent).some((text) => text?.includes('mine'))).toBe(false);
  });

  it('W05 AS-36: a rate-limited read waits for Retry-After and then sends one call with the highest position, saying nothing', async () => {
    readAnswer = (call, seq) => (call === 1 ? problemBody(429, 'rate_limited', {}, { 'retry-after': '10' }) : HttpResponse.json({ lastReadSeq: seq, unread: 0 }));
    open();
    await ready();
    act(() => io.show(rows()[0]!));
    await advance(700);
    await waitFor(() => expect(reads).toHaveLength(1));
    act(() => io.show(rows()[2]!));
    await advance(5_000);
    expect(reads).toHaveLength(1);
    await advance(6_000);
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1]).toEqual({ seq: 3 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('scrolled up (AS-32)', () => {
    const arrive = (client: ReturnType<typeof chatClient>, ...seqs: number[]) =>
      act(() => {
        client.setQueryData<MessagesData>(queryKeys.chat.messages(CH1), (held) => addMessages(held, seqs.map((seq) => message(seq, { authorId: SELLER }))));
      });

    it('W05 AS-32: the list follows new messages only while the reader is at the end', async () => {
      open();
      await ready();
      expect(virtuosoCalls.last?.followOutput?.(true)).toBe('auto');
      expect(virtuosoCalls.last?.followOutput?.(false)).toBe(false);
    });

    it('W05 AS-32: a reader above the end gets a pill "{n} new messages ↓" named "Jump to latest, {n} new messages"; pressing it scrolls to the newest', async () => {
      const { client } = open();
      await ready();
      act(() => virtuosoCalls.last?.atBottomStateChange?.(true));
      expect(screen.queryByRole('button', { name: /Jump to latest/ })).not.toBeInTheDocument();
      act(() => virtuosoCalls.last?.atBottomStateChange?.(false));
      arrive(client, 4, 5);
      const pill = await screen.findByRole('button', { name: 'Jump to latest, 2 new messages' });
      expect(pill).toHaveTextContent('2 new messages');
      await userEvent.click(pill);
      expect(virtuosoCalls.scrolls.some((call) => JSON.stringify(call).includes('LAST'))).toBe(true);
      act(() => virtuosoCalls.last?.atBottomStateChange?.(true));
      expect(screen.queryByRole('button', { name: /Jump to latest/ })).not.toBeInTheDocument();
    });

    it('W05 AS-32: one waiting message reads "1 new message" and the pill counts only other members\' messages', async () => {
      const { client } = open();
      await ready();
      act(() => virtuosoCalls.last?.atBottomStateChange?.(false));
      act(() => {
        client.setQueryData<MessagesData>(queryKeys.chat.messages(CH1), (held) => addMessages(held, [message(4, { authorId: ME, body: 'mine' })]));
      });
      expect(screen.queryByRole('button', { name: /Jump to latest/ })).not.toBeInTheDocument();
      arrive(client, 5);
      expect(await screen.findByRole('button', { name: 'Jump to latest, 1 new message' })).toBeInTheDocument();
    });

    it('W05 AS-32: after the jump the new messages come into view and are marked read', async () => {
      const { client } = open();
      await ready();
      act(() => virtuosoCalls.last?.atBottomStateChange?.(false));
      arrive(client, 4);
      await userEvent.click(await screen.findByRole('button', { name: /Jump to latest/ }));
      act(() => virtuosoCalls.last?.atBottomStateChange?.(true));
      await waitFor(() => expect(rows()).toHaveLength(4));
      act(() => io.show(within(screen.getByRole('list')).getAllByTestId('chat-message')[3]!));
      await advance(700);
      await waitFor(() => expect(reads).toEqual([{ seq: 4 }]));
    });
  });
});
