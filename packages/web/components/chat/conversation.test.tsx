import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { addMessages, type MessagesData } from '@/lib/chat/message-cache';
import { queryKeys } from '@/lib/query-keys';
import { CH1, ME, ORIGIN, OTHER, PRODUCT, SELLER, channel, chatClient, historyPage, inboxItem, inboxPage, message, problemBody, renderChat, mockChatRoutes } from '@/tests/support/chat-fixtures';
import { server } from '../../vitest.setup';
import { Conversation } from './conversation';

const range = (from: number, to: number, over: (seq: number) => Partial<ReturnType<typeof message>> = () => ({})) =>
  Array.from({ length: to - from + 1 }, (_, index) => message(from + index, over(from + index)));

function open(history: Parameters<typeof mockChatRoutes>[0]['history'], options: { unread?: number; channelOver?: Partial<ReturnType<typeof channel>> } = {}) {
  const client = chatClient({ id: ME });
  if (options.unread !== undefined) client.setQueryData(queryKeys.chat.inbox(), { pages: [inboxPage([inboxItem({ id: CH1, unread: options.unread })])], pageParams: [undefined] });
  const calls = mockChatRoutes({ channel: () => channel(options.channelOver), history });
  const view = renderChat(<Conversation channelId={CH1} drafts={new Map()} />, { client });
  return { calls, ...view };
}

const list = () => screen.getByRole('list', { name: 'Messages in Espresso Machine' });
const bodies = () => within(list()).getAllByTestId('chat-message').map((node) => node.textContent ?? '');

describe('Conversation view', () => {
  it('W05 AS-12: shows the title as the heading with a View product link, and the 50 newest messages oldest to newest', async () => {
    const calls = open(() => historyPage(range(51, 100), 'older')).calls;
    expect(await screen.findByRole('heading', { level: 1, name: 'Espresso Machine' })).toHaveAttribute('data-testid', 'chat-title');
    expect(screen.getByRole('link', { name: 'View product' })).toHaveAttribute('href', `/products/${PRODUCT}`);
    await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
    const texts = bodies();
    expect(texts).toHaveLength(50);
    expect(texts[0]).toContain('message 51');
    expect(texts[49]).toContain('message 100');
    expect(calls.history).toBe(1);
  });

  it('W05 AS-12: while loading it shows a skeleton with the status "Loading messages…"', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockChatRoutes({ channel: () => channel() });
    server.use(
      http.get(`${ORIGIN}/api/chat/channels/:id/messages`, async () => {
        await gate;
        return HttpResponse.json(historyPage([message(1)]));
      }),
    );
    renderChat(<Conversation channelId={CH1} drafts={new Map()} />, { user: { id: ME } });
    expect(await screen.findByText('Loading messages…')).toHaveAttribute('role', 'status');
    await act(async () => release());
    await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
  });

  it('W05 AS-12: an empty chat says "No messages yet. Say hello!"', async () => {
    open(() => historyPage([]));
    expect(await screen.findByText('No messages yet. Say hello!')).toBeInTheDocument();
  });

  it('W05 AS-12: a failed load shows "We couldn\'t load this chat." with Try again and the composer disabled', async () => {
    let fail = true;
    open(() => (fail ? problemBody(500, 'internal') : historyPage([message(1)])));
    expect(await screen.findByText("We couldn't load this chat.")).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  });

  it.each([403, 404])('W05 AS-40: %i on the chat shows the unavailable state and nothing from the chat', async (status) => {
    mockChatRoutes({ channel: () => problemBody(status, status === 403 ? 'permission_denied' : 'channel_not_found'), history: () => problemBody(status, 'channel_not_found') });
    renderChat(<Conversation channelId={CH1} drafts={new Map()} />, { user: { id: ME } });
    expect(await screen.findByText("This chat isn't available.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to all chats' })).toHaveAttribute('href', '/chat');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Espresso Machine')).not.toBeInTheDocument();
  });

  it('W05 AS-12: with n unread messages a separator "{n} new messages" sits before the first unread one, and the view opens on it', async () => {
    open(() => historyPage(range(1, 5)), { unread: 2 });
    await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
    const separator = screen.getByRole('separator');
    expect(separator).toHaveTextContent('2 new messages');
    const texts = Array.from(list().querySelectorAll('[data-testid="chat-message"], [role="separator"]')).map((node) => node.textContent ?? '');
    expect(texts.findIndex((text) => text.includes('2 new messages'))).toBe(3);
    expect(texts[4]).toContain('message 4');
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-initial-index', '3');
  });

  it('W05 AS-12: with nothing unread there is no separator and the view opens on the newest message', async () => {
    open(() => historyPage(range(1, 5)), { unread: 0 });
    await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-list')).toHaveAttribute('data-initial-index', '4');
  });

  it('W05 AS-13: Load earlier messages prepends the next page without moving the reader, then "Start of the chat" replaces the button', async () => {
    const cursors: (string | null)[] = [];
    open((_, cursor) => {
      cursors.push(cursor);
      return cursor ? historyPage(range(1, 50)) : historyPage(range(51, 100), 'older');
    });
    await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
    const before = Number(screen.getByTestId('message-list').getAttribute('data-first-item-index'));
    await userEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await waitFor(() => expect(bodies()).toHaveLength(100));
    expect(cursors).toEqual([null, 'older']);
    expect(Number(screen.getByTestId('message-list').getAttribute('data-first-item-index'))).toBe(before - 50);
    expect(bodies()[0]).toContain('message 1');
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument();
    expect(screen.getByText('Start of the chat')).toBeInTheDocument();
  });

  it('W05 AS-13: a failed earlier page keeps the loaded messages and offers Try again', async () => {
    let fail = true;
    open((_, cursor) => (cursor ? (fail ? problemBody(500, 'internal') : historyPage(range(1, 50))) : historyPage(range(51, 100), 'older')));
    await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
    await userEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(await screen.findByText("Couldn't load earlier messages.")).toBeInTheDocument();
    expect(bodies()).toHaveLength(50);
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bodies()).toHaveLength(100));
  });

  it('W05 AS-22: authors are You, Seller or Buyer plus four characters; own messages align to the end and show their time', async () => {
    open(() => historyPage([message(1, { authorId: ME, body: 'mine' }), message(2, { authorId: SELLER, body: 'theirs' }), message(3, { authorId: OTHER, body: 'third' })]));
    await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
    const [mine, seller, buyer] = within(list()).getAllByTestId('chat-message');
    expect(mine).toHaveTextContent('You');
    expect(seller).toHaveTextContent('Seller');
    expect(buyer).toHaveTextContent('Buyer 6f7a');
    expect(mine).toHaveAttribute('data-own', 'true');
    expect(seller).toHaveAttribute('data-own', 'false');
    expect(within(mine!).getByText(/\d/, { selector: 'time' })).toBeInTheDocument();
  });

  it('W05 AS-22: a day separator sits at the start and wherever the day changes; a tombstone reads "Message removed"', async () => {
    open(() =>
      historyPage([
        message(1, { createdAt: new Date(2020, 0, 1, 10, 0).toISOString() }),
        message(2, { createdAt: new Date(2020, 0, 1, 11, 0).toISOString() }),
        message(3, { createdAt: new Date(2020, 0, 2, 9, 0).toISOString(), deleted: true, body: null }),
      ]),
    );
    await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
    expect(screen.getAllByTestId('day-separator')).toHaveLength(2);
    expect(within(list()).getAllByTestId('chat-message')[2]).toHaveTextContent('Message removed');
  });

  it('W05 AS-22: a body is plain text: HTML and Markdown are shown as typed, never rendered', async () => {
    const body = '<b>bold</b> **star** [link](http://example.com)\nsecond line';
    open(() => historyPage([message(1, { body })]));
    await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
    const node = within(list()).getByTestId('chat-message');
    expect(node.textContent).toContain('<b>bold</b> **star** [link](http://example.com)');
    expect(node.querySelector('b, strong, a')).toBeNull();
    expect(node.querySelector('[data-body]')?.className).toContain('whitespace-pre-wrap');
  });

  it('W05 AS-22: rows are ordered by seq whatever order the page arrived in', async () => {
    const scrambled = { items: [message(5), message(3), message(4), message(1), message(2)], nextCursor: null };
    open(() => scrambled);
    await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
    expect(bodies().map((text) => Number(/message (\d)/.exec(text)?.[1]))).toEqual([1, 2, 3, 4, 5]);
  });

  it('W05 AS-22: rows are keyed by message id: a new message does not remount the ones already shown', async () => {
    const { client } = open(() => historyPage([message(1), message(2)]));
    await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
    const second = within(list()).getAllByTestId('chat-message')[1];
    act(() => {
      client.setQueryData<MessagesData>(queryKeys.chat.messages(CH1), (held) => addMessages(held, [message(3)]));
    });
    await waitFor(() => expect(bodies()).toHaveLength(3));
    expect(within(list()).getAllByTestId('chat-message')[1]).toBe(second);
  });

  it('W05 AS-13: only loaded pages are in the list: a long chat reads the first page and nothing more until asked', async () => {
    const calls = open(() => historyPage(range(951, 1000), 'older')).calls;
    await screen.findByRole('list', { name: 'Messages in Espresso Machine' });
    expect(bodies()).toHaveLength(50);
    expect(calls.history).toBe(1);
  });
});
