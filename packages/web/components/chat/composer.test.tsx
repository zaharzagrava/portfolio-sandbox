import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addMessages, type MessagesData } from '@/lib/chat/message-cache';
import { queryKeys } from '@/lib/query-keys';
import { CH1, CH2, ME, ORIGIN, SELLER, channel, chatClient, historyPage, message, problemBody, renderChat, mockChatRoutes } from '@/tests/support/chat-fixtures';
import { server } from '../../vitest.setup';
import { Conversation } from './conversation';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

type Sent = { clientMessageId: string; body: string; replyToId?: string };
const SEND = `${ORIGIN}/api/chat/channels/${CH1}/messages`;

function open(options: { history?: ReturnType<typeof message>[]; channelOver?: Partial<ReturnType<typeof channel>>; drafts?: Map<string, string> } = {}) {
  const client = chatClient({ id: ME });
  const sent: Sent[] = [];
  mockChatRoutes({ channel: () => channel(options.channelOver), history: () => historyPage(options.history ?? [message(1)]) });
  const drafts = options.drafts ?? new Map<string, string>();
  const view = renderChat(<Conversation channelId={CH1} drafts={drafts} />, { client });
  return { sent, drafts, ...view };
}

/** A send route: records the bodies and answers with `answer` (a stored message by default). */
function sendRoute(sent: Sent[], answer?: (body: Sent, attempt: number) => Response | Promise<Response>) {
  let attempt = 0;
  server.use(
    http.post(SEND, async ({ request }) => {
      const body = (await request.json()) as Sent;
      sent.push(body);
      attempt += 1;
      if (answer) return answer(body, attempt);
      return HttpResponse.json({ message: message(50 + attempt, { authorId: ME, body: body.body }), duplicate: false }, { status: 201 });
    }),
  );
}

const field = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: 'Send message' });
const ready = () => screen.findByRole('list', { name: 'Messages in Espresso Machine' });
const own = () => screen.queryAllByTestId('chat-message').filter((node) => node.getAttribute('data-own') === 'true');

afterEach(() => {
  vi.useRealTimers();
  toast.error.mockReset();
});

describe('Chat composer', () => {
  it('W05 AS-14: Enter shows the bubble at once with "You" and "Sending…", empties the field and keeps focus; the answer turns it into a normal message', async () => {
    const view = open();
    const sent = view.sent;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    sendRoute(sent, async (body) => {
      await gate;
      return HttpResponse.json({ message: message(2, { authorId: ME, body: body.body }), duplicate: false }, { status: 201 });
    });
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), 'Hello there{Enter}');
    const bubble = own()[0]!;
    expect(bubble).toHaveTextContent('You');
    expect(bubble).toHaveTextContent('Hello there');
    expect(bubble).toHaveTextContent('Sending…');
    expect(field()).toHaveValue('');
    expect(field()).toHaveFocus();
    await act(async () => release());
    await waitFor(() => expect(screen.queryByText('Sending…')).not.toBeInTheDocument());
    expect(own()).toHaveLength(1);
    expect(own()[0]).toHaveTextContent('Hello there');
    expect(own()[0]?.querySelector('time')).not.toBeNull();
    expect(screen.getByText('Message sent')).toHaveAttribute('role', 'status');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe('Hello there');
    expect(sent[0]?.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('W05 AS-14: the same message arriving by a live hint or sync before the answer is shown once, and still once after the answer', async () => {
    const view = open();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    sendRoute(view.sent, async (body) => {
      await gate;
      return HttpResponse.json({ message: message(2, { authorId: ME, body: body.body }), duplicate: false }, { status: 201 });
    });
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), 'Hello{Enter}');
    act(() => {
      view.client.setQueryData<MessagesData>(queryKeys.chat.messages(CH1), (held) => addMessages(held, [message(2, { authorId: ME, body: 'Hello' })]));
    });
    expect(screen.getAllByText('Hello')).toHaveLength(1);
    await act(async () => release());
    await waitFor(() => expect(view.sent).toHaveLength(1));
    await waitFor(() => expect(screen.getByText('Message sent')).toBeInTheDocument());
    expect(screen.getAllByText('Hello')).toHaveLength(1);
  });

  it('W05 AS-15: the field is labelled "Message", has the placeholder, and Send is named "Send message"', async () => {
    open();
    await ready();
    expect(field()).toHaveAttribute('placeholder', 'Type a message…');
    expect(sendButton()).toBeDisabled();
  });

  it('W05 AS-15: Shift+Enter inserts a newline and sends nothing; Enter during IME composition never sends', async () => {
    const { sent } = open();
    sendRoute(sent);
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), 'one{Shift>}{Enter}{/Shift}two');
    expect(field()).toHaveValue('one\ntwo');
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(sent).toHaveLength(0);
    expect(field()).toHaveValue('one\ntwo');
  });

  it('W05 AS-15: the text is trimmed before sending, and a whitespace-only draft keeps Send disabled', async () => {
    const { sent } = open();
    sendRoute(sent);
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), '   ');
    expect(sendButton()).toBeDisabled();
    await userEvent.type(field(), '{Enter}');
    expect(sent).toHaveLength(0);
    await userEvent.type(field(), ' hi ');
    await userEvent.click(sendButton());
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toBe('hi');
  });

  it('W05 AS-15: beyond 3,500 code points a counter appears, live only when crossing; typing or pasting past 4,000 is cut at the limit', async () => {
    open();
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    expect(screen.queryByText(/\/ 4,000/)).not.toBeInTheDocument();
    await userEvent.click(field());
    await userEvent.paste('a'.repeat(3501));
    const counter = screen.getByText('3,501 / 4,000');
    expect(counter).toHaveAttribute('aria-live', 'polite');
    await userEvent.paste('b');
    expect(screen.getByText('3,502 / 4,000')).toHaveAttribute('aria-live', 'off');
    await userEvent.paste('c'.repeat(600));
    expect(screen.getByText('4,000 / 4,000')).toBeInTheDocument();
    expect(field().value).toHaveLength(4000);
  });

  it('W05 AS-15: the limit counts code points, so a pasted emoji run is cut at 4,000 emoji, never inside one', async () => {
    open();
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.click(field());
    await userEvent.paste('😀'.repeat(4100));
    expect([...field().value]).toHaveLength(4000);
    expect(screen.getByText('4,000 / 4,000')).toBeInTheDocument();
  });

  it('W05 AS-15: the draft of each chat is kept while the member looks at another chat in the same visit', async () => {
    const drafts = new Map<string, string>();
    const view = open({ drafts });
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), 'half a thought');
    view.rerenderChat(<Conversation key={CH2} channelId={CH2} drafts={drafts} />);
    await waitFor(() => expect(field()).toHaveValue(''));
    view.rerenderChat(<Conversation key={CH1} channelId={CH1} drafts={drafts} />);
    await waitFor(() => expect(field()).toHaveValue('half a thought'));
    expect(JSON.stringify(Object.entries(window.localStorage)) + JSON.stringify(Object.entries(window.sessionStorage))).not.toContain('half a thought');
  });

  it('W05 AS-16: a failed send stays as "Not sent" with Retry and Discard; Retry re-sends the same clientMessageId and a request that had succeeded is shown once', async () => {
    const { sent } = open();
    sendRoute(sent, (body, attempt) => (attempt === 1 ? HttpResponse.error() : HttpResponse.json({ message: message(2, { authorId: ME, body: body.body }), duplicate: true }, { status: 200 })));
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), 'ping{Enter}');
    const failed = await screen.findByText('Not sent');
    expect(failed).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Not sent')).not.toBeInTheDocument());
    expect(sent).toHaveLength(2);
    expect(sent[1]?.clientMessageId).toBe(sent[0]?.clientMessageId);
    expect(sent[1]?.body).toBe(sent[0]?.body);
    expect(screen.getAllByText('ping')).toHaveLength(1);
  });

  it('W05 AS-16: Discard removes the bubble; later drafts may be sent while one bubble is not sent', async () => {
    const { sent } = open();
    sendRoute(sent, (body, attempt) => (attempt === 1 ? HttpResponse.error() : HttpResponse.json({ message: message(3, { authorId: ME, body: body.body }), duplicate: false }, { status: 201 })));
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), 'lost{Enter}');
    await screen.findByText('Not sent');
    await userEvent.type(field(), 'next{Enter}');
    await waitFor(() => expect(sent).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText('lost')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('next')).toBeInTheDocument());
  });

  it('W05 AS-17: a send that failed for lack of a network is retried once, automatically, with the same clientMessageId when the browser is back online; a refusal never is', async () => {
    const { sent } = open();
    sendRoute(sent, (body, attempt) => {
      if (attempt === 1) return HttpResponse.error();
      if (body.body === 'refused') return problemBody(400, 'validation_failed');
      return HttpResponse.json({ message: message(2, { authorId: ME, body: body.body }), duplicate: false }, { status: 201 });
    });
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), 'lost{Enter}');
    await screen.findByText('Not sent');
    await userEvent.type(field(), 'refused{Enter}');
    await screen.findByText("That message can't be sent.");
    expect(sent).toHaveLength(2);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]?.clientMessageId).toBe(sent[0]?.clientMessageId);
    await waitFor(() => expect(screen.getAllByText('Not sent')).toHaveLength(1));
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent).toHaveLength(3);
  });

  it('W05 AS-18: 403 banned replaces the composer with "You can no longer take part in this chat."', async () => {
    const { sent } = open();
    sendRoute(sent, () => problemBody(403, 'banned'));
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), 'hi{Enter}');
    expect(await screen.findByText('You can no longer take part in this chat.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
  });

  it('W05 AS-18: 403 muted disables the composer until mutedUntil and a timer re-enables it, draft kept', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { sent } = open();
    const until = new Date(Date.now() + 10_000).toISOString();
    sendRoute(sent, () => problemBody(403, 'muted', { mutedUntil: until }));
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), 'hi{Enter}');
    expect(await screen.findByText(/You're muted until/)).toBeInTheDocument();
    expect(field()).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(screen.queryByText(/You're muted until/)).not.toBeInTheDocument();
    expect(field()).toBeEnabled();
  });

  it('W05 AS-18: an archived chat (on load) disables the composer with the reason beside it', async () => {
    open({ channelOver: { isArchived: true } });
    expect(await screen.findByText('This chat was archived. You can read it, but not reply.')).toBeInTheDocument();
    await ready();
    expect(field()).toBeDisabled();
    expect(sendButton()).toBeDisabled();
  });

  it('W05 AS-18: 409 channel_archived on a send flips the composer and the bubble is marked Not sent', async () => {
    const { sent } = open();
    sendRoute(sent, () => problemBody(409, 'channel_archived'));
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), 'late{Enter}');
    expect(await screen.findByText('This chat was archived. You can read it, but not reply.')).toBeInTheDocument();
    expect(field()).toBeDisabled();
    expect(screen.getByText('Not sent')).toBeInTheDocument();
  });

  it('W05 AS-18: 404 channel_not_found on a send replaces the pane with the unavailable state', async () => {
    const { sent } = open();
    sendRoute(sent, () => problemBody(404, 'channel_not_found'));
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), 'hi{Enter}');
    expect(await screen.findByText("This chat isn't available.")).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('W05 AS-18: 400 validation_failed marks the bubble Not sent with "That message can\'t be sent."', async () => {
    const { sent } = open();
    sendRoute(sent, () => problemBody(400, 'validation_failed'));
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), 'hi{Enter}');
    expect(await screen.findByText("That message can't be sent.")).toBeInTheDocument();
    expect(screen.getByText('Not sent')).toBeInTheDocument();
  });

  it('W05 AS-18: 422 reply_target_invalid drops the reference; Retry sends the text without it under a new clientMessageId', async () => {
    const { sent } = open({ history: [message(1, { authorId: SELLER, body: 'original' })] });
    sendRoute(sent, (body, attempt) => (attempt === 1 ? problemBody(422, 'reply_target_invalid') : HttpResponse.json({ message: message(2, { authorId: ME, body: body.body }), duplicate: false }, { status: 201 })));
    await ready();
    await userEvent.click(screen.getByRole('button', { name: /Message actions for the message from Seller/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reply' }));
    await waitFor(() => expect(field()).toHaveFocus());
    await userEvent.type(field(), 'answer{Enter}');
    expect(await screen.findByText('The message you replied to is no longer available.')).toBeInTheDocument();
    expect(sent[0]?.replyToId).toBe(message(1).id);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.replyToId).toBeUndefined();
    expect(sent[1]?.clientMessageId).not.toBe(sent[0]?.clientMessageId);
    expect(sent[1]?.body).toBe('answer');
  });

  it('W05 AS-19: 429 shows the wait under the composer and Retry is disabled until the wait ends, then enables itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { sent } = open();
    sendRoute(sent, () => problemBody(429, 'rate_limited', {}, { 'retry-after': '30' }));
    await ready();
    await waitFor(() => expect(field()).toBeEnabled());
    await userEvent.type(field(), 'fast{Enter}');
    expect(await screen.findByText("You're sending messages too fast. Try again in 30 seconds.")).toBeInTheDocument();
    expect(screen.getByText('Not sent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(screen.queryByText(/You're sending messages too fast/)).not.toBeInTheDocument();
    expect(field()).toBeEnabled();
  });

  it('W05 AS-21: choosing Reply shows "Replying to {author}: {text}" with Cancel reply, focuses the field, and the sent message carries the reference and a quoted preview', async () => {
    const { sent } = open({ history: [message(1, { authorId: SELLER, body: 'Is it still available?' })] });
    sendRoute(sent);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: /Message actions for the message from Seller/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reply' }));
    expect(screen.getByText('Replying to Seller: Is it still available?')).toBeInTheDocument();
    await waitFor(() => expect(field()).toHaveFocus());
    await userEvent.type(field(), 'yes{Enter}');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.replyToId).toBe(message(1).id);
    expect(screen.queryByText(/Replying to/)).not.toBeInTheDocument();
  });

  it('W05 AS-21: Cancel reply drops the reference', async () => {
    const { sent } = open({ history: [message(1, { authorId: SELLER })] });
    sendRoute(sent);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: /Message actions for the message from Seller/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reply' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));
    expect(screen.queryByText(/Replying to/)).not.toBeInTheDocument();
    await userEvent.type(field(), 'plain{Enter}');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.replyToId).toBeUndefined();
  });

  it.each([
    ['a loaded original', [message(1, { authorId: SELLER, body: 'Original text here' }), message(2, { authorId: ME, body: 'reply', replyToId: message(1).id })], 'Seller: Original text here'],
    ['an original that is not loaded', [message(2, { authorId: ME, body: 'reply', replyToId: message(99).id })], 'Original message'],
    ['a deleted original', [message(1, { authorId: SELLER, body: null, deleted: true }), message(2, { authorId: ME, body: 'reply', replyToId: message(1).id })], 'Message removed'],
  ])('W05 AS-21: a reply shows a quoted preview of %s', async (_name, history, quote) => {
    open({ history });
    await ready();
    const reply = screen.getAllByTestId('chat-message').find((node) => node.textContent?.includes('reply'));
    expect(within(reply!).getByText(quote)).toBeInTheDocument();
  });
});
