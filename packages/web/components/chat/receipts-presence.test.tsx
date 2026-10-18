import { act, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatReceipts } from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { CH1, ME, ORIGIN, OTHER, SELLER, channel, chatClient, historyPage, message, mockChatRoutes, problemBody, renderChat } from '@/tests/support/chat-fixtures';
import { server } from '../../vitest.setup';
import { Conversation } from './conversation';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

let receipts: ChatReceipts | Response = { items: [], suppressed: false };
let presence: (call: number) => Response = () => HttpResponse.json({});
const beats: number[] = [];
const presenceCalls: string[] = [];
let beatAnswer: (call: number) => Response = () => new HttpResponse(null, { status: 204 });

function open(options: { self?: string; history?: ReturnType<typeof message>[]; sellerId?: string } = {}) {
  const self = options.self ?? ME;
  const client = chatClient({ id: self });
  mockChatRoutes({
    channel: () => channel({ sellerId: options.sellerId ?? SELLER }),
    history: () => historyPage(options.history ?? [message(1, { authorId: self, body: 'my question' })]),
  });
  server.use(
    http.get(`${ORIGIN}/api/chat/channels/${CH1}/receipts`, () => (receipts instanceof Response ? receipts : HttpResponse.json(receipts))),
    http.get(`${ORIGIN}/api/chat/presence`, ({ request }) => {
      presenceCalls.push(new URL(request.url).searchParams.get('userIds') ?? '');
      return presence(presenceCalls.length);
    }),
    http.post(`${ORIGIN}/api/chat/presence/heartbeat`, () => {
      beats.push(Date.now());
      return beatAnswer(beats.length);
    }),
  );
  return renderChat(<Conversation channelId={CH1} drafts={new Map()} />, { client });
}

const ready = () => screen.findByRole('list', { name: 'Messages in Espresso Machine' });
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const setVisible = (visible: boolean) =>
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: visible ? 'visible' : 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  receipts = { items: [], suppressed: false };
  presence = () => HttpResponse.json({});
  beatAnswer = () => new HttpResponse(null, { status: 204 });
  beats.length = 0;
  presenceCalls.length = 0;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  toast.error.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('Receipts and presence', () => {
  describe('Seen by (AS-33)', () => {
    it('W05 AS-33: one reader at or past the message shows "Seen" under the member\'s newest message that others have read', async () => {
      receipts = { items: [{ userId: SELLER, lastReadSeq: 1 }], suppressed: false };
      open();
      await ready();
      expect(await screen.findByTestId('seen-by')).toHaveTextContent('Seen');
      expect(screen.getByTestId('seen-by').textContent).toBe('Seen');
    });

    it('W05 AS-33: two distinct readers read "Seen by 2"; the member\'s own position never counts', async () => {
      receipts = { items: [{ userId: SELLER, lastReadSeq: 4 }, { userId: OTHER, lastReadSeq: 1 }, { userId: ME, lastReadSeq: 9 }], suppressed: false };
      open();
      await ready();
      expect((await screen.findByTestId('seen-by')).textContent).toBe('Seen by 2');
    });

    it('W05 AS-33: a reader who has not reached the message is not counted, and with no data nothing is shown', async () => {
      receipts = { items: [{ userId: SELLER, lastReadSeq: 0 }], suppressed: false };
      open({ history: [message(5, { authorId: ME, body: 'late question' })] });
      await ready();
      await waitFor(() => expect(screen.queryByTestId('seen-by')).not.toBeInTheDocument());
    });

    it('W05 AS-33: when the receipts cannot be read nothing is shown (never a guess), and no error either', async () => {
      receipts = problemBody(500, 'internal');
      open();
      await ready();
      await advance(500);
      expect(screen.queryByTestId('seen-by')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('W05 AS-33: in a large chat no receipts exist and nothing is shown', async () => {
      receipts = { items: [], suppressed: true };
      open();
      await ready();
      await advance(500);
      expect(screen.queryByTestId('seen-by')).not.toBeInTheDocument();
    });

    it('W05 AS-33: a live "read" event raises a position and the label appears without a reload', async () => {
      const view = open();
      await ready();
      await advance(300);
      expect(screen.queryByTestId('seen-by')).not.toBeInTheDocument();
      act(() => {
        view.client.setQueryData<ChatReceipts>(queryKeys.chat.receipts(CH1), { suppressed: false, items: [{ userId: SELLER, lastReadSeq: 1 }] });
      });
      expect(await screen.findByTestId('seen-by')).toHaveTextContent('Seen');
    });
  });

  describe('presence (AS-34)', () => {
    it('W05 AS-34: a heartbeat is sent when the chat opens and every 30 seconds while the tab is visible', async () => {
      open();
      await ready();
      await waitFor(() => expect(beats).toHaveLength(1));
      await advance(29_000);
      expect(beats).toHaveLength(1);
      await advance(2_000);
      await waitFor(() => expect(beats).toHaveLength(2));
      await advance(30_000);
      await waitFor(() => expect(beats).toHaveLength(3));
    });

    it('W05 AS-34: a hidden tab sends no heartbeat and reads no presence; a visible one resumes', async () => {
      open();
      await ready();
      await waitFor(() => expect(beats).toHaveLength(1));
      await setVisible(false);
      const reads = presenceCalls.length;
      await advance(120_000);
      expect(beats).toHaveLength(1);
      expect(presenceCalls).toHaveLength(reads);
      await setVisible(true);
      await waitFor(() => expect(beats).toHaveLength(2));
    });

    it('W05 AS-34: a member who is not the seller reads the seller\'s presence, and "Seller online" shows as text with a dot', async () => {
      presence = () => HttpResponse.json({ [SELLER]: { online: true, lastSeenAt: 1 } });
      open();
      await ready();
      expect(await screen.findByText('Seller online')).toBeInTheDocument();
      expect(presenceCalls[0]).toBe(SELLER);
      await advance(31_000);
      await waitFor(() => expect(presenceCalls.length).toBeGreaterThanOrEqual(2));
    });

    it('W05 AS-34: nothing is shown when the seller is not online (no "offline", no "last seen")', async () => {
      presence = () => HttpResponse.json({ [SELLER]: { online: false, lastSeenAt: 1 } });
      open();
      await ready();
      await waitFor(() => expect(presenceCalls.length).toBeGreaterThanOrEqual(1));
      await advance(300);
      expect(screen.queryByText(/online|offline|last seen/i)).not.toBeInTheDocument();
    });

    it('W05 AS-34: the seller sees no presence indicator for themselves and makes no presence read', async () => {
      presence = () => HttpResponse.json({ [SELLER]: { online: true, lastSeenAt: 1 } });
      open({ self: SELLER, history: [message(1, { authorId: OTHER, body: 'hello' })] });
      await ready();
      await waitFor(() => expect(beats).toHaveLength(1));
      await advance(500);
      expect(presenceCalls).toHaveLength(0);
      expect(screen.queryByText('Seller online')).not.toBeInTheDocument();
    });
  });

  describe('presence is optional (AS-35)', () => {
    it('W05 AS-35: 503 presence_unavailable removes the indicator without a toast or a banner, and chat still works', async () => {
      presence = (call) => (call === 1 ? HttpResponse.json({ [SELLER]: { online: true, lastSeenAt: 1 } }) : problemBody(503, 'presence_unavailable'));
      open();
      expect(await screen.findByText('Seller online')).toBeInTheDocument();
      await advance(31_000);
      await waitFor(() => expect(screen.queryByText('Seller online')).not.toBeInTheDocument());
      expect(toast.error).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
    });

    it('W05 AS-35: 429 on a heartbeat pauses heartbeats for Retry-After seconds (60 when absent) and then resumes', async () => {
      beatAnswer = (call) => (call === 1 ? problemBody(429, 'rate_limited', {}, { 'retry-after': '90' }) : new HttpResponse(null, { status: 204 }));
      open();
      await ready();
      await waitFor(() => expect(beats).toHaveLength(1));
      await advance(80_000);
      expect(beats).toHaveLength(1);
      await advance(11_000);
      await waitFor(() => expect(beats).toHaveLength(2));
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('W05 AS-35: 429 on a presence read pauses reads too, and the default pause is 60 seconds', async () => {
      presence = (call) => (call === 1 ? problemBody(429, 'rate_limited') : HttpResponse.json({ [SELLER]: { online: true, lastSeenAt: 1 } }));
      open();
      await ready();
      await waitFor(() => expect(presenceCalls).toHaveLength(1));
      await advance(55_000);
      expect(presenceCalls).toHaveLength(1);
      await advance(10_000);
      await waitFor(() => expect(presenceCalls.length).toBeGreaterThanOrEqual(2));
      expect(await screen.findByText('Seller online')).toBeInTheDocument();
    });
  });
});
