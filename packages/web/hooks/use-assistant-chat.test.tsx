import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { CONVERSATION_ID, DONE, META, TEXT } from '../tests/support/fake-assistant';

const fake = await vi.hoisted(async () => (await import('../tests/support/fake-assistant')).createFakeAssistant());
const toast = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'u1', email: 'a@b.c', role: 'USER' }, status: 'authenticated', isAuthenticated: true, isLoading: false }) }));
vi.mock('@/lib/api/assistant', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api/assistant')>()), assistantApi: fake.api }));

import { AssistantRejected } from '@/lib/api/assistant';
import { useAssistantChat } from './use-assistant-chat';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useAssistantChat({ active: true }), { wrapper });
  return { ...hook, client };
}

const keyOf = (n: number) => (fake.calls[n].args[1] as { key: string }).key;

async function sendText(result: { current: ReturnType<typeof useAssistantChat> }, text: string) {
  act(() => result.current.setInput(text));
  act(() => result.current.send());
}

beforeEach(() => {
  fake.reset();
  sessionStorage.clear();
  toast.error.mockClear();
});

describe('Assistant chat hook (stream, resume, stop, retry)', () => {
  it('W05 AS-45: every send carries its own Idempotency-Key, a new text gets a new key, and the conversation is created once', async () => {
    const { result } = setup();
    await sendText(result, 'hi');
    const first = await fake.call(0);
    act(() => first.emit(META('m1'), '1-0'));
    act(() => first.emit(TEXT('Hello'), '2-0'));
    act(() => first.emit(DONE(), '3-0'));
    await act(async () => first.end({ terminal: true }));

    await sendText(result, 'again');
    const second = await fake.call(1);
    act(() => second.emit(META('m2'), '4-0'));
    act(() => second.emit(DONE(), '5-0'));
    await act(async () => second.end({ terminal: true }));

    expect(keyOf(0)).toMatch(/^[0-9a-f-]{36}$/);
    expect(keyOf(1)).toMatch(/^[0-9a-f-]{36}$/);
    expect(keyOf(1)).not.toBe(keyOf(0));
    expect(fake.api.createConversation).toHaveBeenCalledTimes(1);
    expect(fake.calls[1].args[0]).toBe(CONVERSATION_ID);
  });

  it('W05 AS-45: the same unsent text sent again after a lost response reuses the key; an edited text gets a new key', async () => {
    const { result } = setup();
    await sendText(result, 'find a phone');
    const lost = await fake.call(0);
    await act(async () => lost.fail(new TypeError('network error')));
    expect(result.current.reply.phase).toBe('ended');

    act(() => result.current.tryAgain());
    expect(result.current.input).toBe('find a phone');
    act(() => result.current.send());
    await fake.call(1);
    expect(keyOf(1)).toBe(keyOf(0));

    await act(async () => fake.calls[1].fail(new TypeError('network error')));
    await sendText(result, 'find a phone under 800');
    await fake.call(2);
    expect(keyOf(2)).not.toBe(keyOf(0));
  });

  it('W05 AS-45: a double press sends one turn', async () => {
    const { result } = setup();
    act(() => result.current.setInput('hi'));
    act(() => {
      result.current.send();
      result.current.send();
    });
    await fake.call(0);
    expect(fake.api.send).toHaveBeenCalledTimes(1);
    expect(fake.api.createConversation).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-42: the reply is built from meta, text in arrival order and the exchange stays visible after done', async () => {
    const { result } = setup();
    await sendText(result, 'hi');
    const call = await fake.call(0);
    act(() => call.emit(META('m1'), '1-0'));
    act(() => call.emit(TEXT('Hel'), '2-0'));
    act(() => call.emit(TEXT('lo'), '3-0'));
    expect(result.current.items.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello'],
    ]);
    expect(result.current.items[1].id).toBe('m1');
    expect(result.current.running).toBe(true);
    act(() => call.emit(DONE(), '4-0'));
    await act(async () => call.end({ terminal: true }));
    expect(result.current.running).toBe(false);
    expect(result.current.items.map((m) => m.content)).toEqual(['hi', 'Hello']);
    expect(result.current.announce.end).toBe('Answer ready');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('W05 AS-42: bubble ids are stable and never built from the clock or an index', async () => {
    const { result } = setup();
    await sendText(result, 'hi');
    const call = await fake.call(0);
    act(() => call.emit(META('m7'), '1-0'));
    const ids = result.current.items.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.join(' ')).not.toMatch(/user-\d{10,}/);
    await sendText(result, 'second');
    expect(result.current.items.map((m) => m.id)).toEqual(ids);
  });

  it('W05 AS-56: a refused send gives the text back, adds nothing to the transcript and uses no toast', async () => {
    const { result } = setup();
    await sendText(result, 'my card is 4111 1111 1111 1111');
    const call = await fake.call(0);
    await act(async () => call.fail(new AssistantRejected(422, { code: 'input_rejected', category: 'sensitive_data' }, {})));
    expect(result.current.input).toBe('my card is 4111 1111 1111 1111');
    expect(result.current.items).toEqual([]);
    expect(result.current.notice).toMatchObject({ text: 'Your message looks like it contains a card number or a password. Remove it and try again.' });
    expect(toast.error).not.toHaveBeenCalled();
    // the same text sent again keeps its key (a refused send did not start a turn)
    act(() => result.current.send());
    await fake.call(1);
    expect(keyOf(1)).toBe(keyOf(0));
  });
});

const historyWith = (assistantId: string | null) => ({
  conversation: { id: CONVERSATION_ID, title: 'New chat', updatedAt: '2026-10-17T10:00:00.000Z' },
  messages: [
    { id: 'hu1', turnId: 't1', role: 'user' as const, text: 'hi', tools: [] },
    ...(assistantId ? [{ id: assistantId, turnId: 't1', role: 'assistant' as const, text: 'Full answer', tools: ['search_products'] }] : []),
  ],
});
const rest = (status: number, code: string) => ({ response: { status, data: { code }, headers: {} } });

/** Sends "hi" and gets the reply to `meta` + "Hel" (event ids 1-0, 2-0) on the first connection. */
async function startReply(result: { current: ReturnType<typeof useAssistantChat> }) {
  await sendText(result, 'hi');
  const call = await fake.call(0);
  act(() => call.emit(META('m1'), '1-0'));
  act(() => call.emit(TEXT('Hel'), '2-0'));
  return call;
}

describe('Assistant chat hook: a dropped connection never loses an answer', () => {
  afterEach(() => vi.useRealTimers());

  it('W05 AS-49: a cut stream shows "Reconnecting…" at once and continues after the last event id with no repeated or lost text', async () => {
    const { result } = setup();
    const first = await startReply(result);
    await act(async () => first.end({ terminal: false }));
    expect(result.current.items.at(-1)).toMatchObject({ role: 'assistant', content: 'Hel', live: 'reconnecting' });

    const second = await fake.call(1);
    expect(second.kind).toBe('resume');
    expect(second.args).toEqual(['m1', '2-0']);
    act(() => second.emit(TEXT('lo'), '3-0'));
    act(() => second.emit(DONE(), '4-0'));
    await act(async () => second.end({ terminal: true }));
    expect(result.current.items.map((m) => m.content)).toEqual(['hi', 'Hello']);
    expect(result.current.running).toBe(false);
    expect(fake.api.send).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-49: attempts follow 0, 1, 2, 4, 8 s and then every 10 s; after 2 minutes the reply is given up with "We couldn\'t reconnect to the reply."', async () => {
    vi.useFakeTimers();
    const { result } = setup();
    await sendText(result, 'hi');
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const first = fake.calls[0];
    act(() => first.emit(META('m1'), '1-0'));
    act(() => first.emit(TEXT('Hel'), '2-0'));
    const dropAt = Date.now();
    await act(async () => first.end({ terminal: false }));

    const times: number[] = [];
    let seen = 1;
    await act(async () => vi.advanceTimersByTimeAsync(0));
    for (let step = 0; step < 140_000 && result.current.running; step += 500) {
      while (fake.calls.length > seen) {
        times.push(Date.now() - dropAt);
        await act(async () => fake.calls[seen].fail(new TypeError('network error')));
        seen += 1;
      }
      await act(async () => vi.advanceTimersByTimeAsync(500));
    }
    expect(times.slice(0, 7)).toEqual([0, 1000, 2000, 4000, 8000, 18000, 28000]);
    expect(Math.max(...times)).toBeLessThan(120_000);
    expect(result.current.running).toBe(false);
    expect(result.current.notice).toMatchObject({ text: "We couldn't reconnect to the reply.", tryAgain: 'reattach' });
    expect(result.current.items.at(-1)?.content).toBe('Hel');
  });

  it('W05 AS-50: after a reload the remembered reply is re-attached without Last-Event-ID, rebuilt from meta, and the pending text goes at the end', async () => {
    sessionStorage.setItem('assistant.active', JSON.stringify({ conversationId: CONVERSATION_ID, messageId: 'm1', pendingText: 'hi', idempotencyKey: 'k1' }));
    const { result } = setup();
    const call = await fake.call(0);
    expect(call.kind).toBe('resume');
    expect(call.args).toEqual(['m1', undefined]);
    expect(result.current.items.map((m) => [m.role, m.content, m.live])).toEqual([
      ['user', 'hi', undefined],
      ['assistant', '', 'reconnecting'],
    ]);

    act(() => call.emit(META('m1'), '1-0'));
    act(() => call.emit(TEXT('Hel'), '2-0'));
    // the same events again (a second meta replays from the start) never double the text
    expect(result.current.items.at(-1)?.content).toBe('Hel');
    act(() => call.emit(DONE(), '3-0'));
    await act(async () => call.end({ terminal: true }));
    expect(JSON.parse(sessionStorage.getItem('assistant.active') ?? 'null')).toEqual({ conversationId: CONVERSATION_ID });
  });

  it('W05 AS-48: a running reply is remembered for the tab (ids only) and forgotten when it ends', async () => {
    const { result } = setup();
    const call = await startReply(result);
    expect(JSON.parse(sessionStorage.getItem('assistant.active') ?? 'null')).toEqual({ conversationId: CONVERSATION_ID, messageId: 'm1', pendingText: 'hi', idempotencyKey: keyOf(0) });
    act(() => call.emit(DONE(), '3-0'));
    await act(async () => call.end({ terminal: true }));
    expect(JSON.parse(sessionStorage.getItem('assistant.active') ?? 'null')).toEqual({ conversationId: CONVERSATION_ID });
  });

  it('W05 AS-48: a remembered conversation that no longer exists falls back to the empty state', async () => {
    sessionStorage.setItem('assistant.active', JSON.stringify({ conversationId: CONVERSATION_ID }));
    fake.api.history.mockRejectedValue(rest(404, 'not_found'));
    const { result } = setup();
    await vi.waitFor(() => expect(result.current.conversationId).toBeNull());
    expect(result.current.items).toEqual([]);
    expect(result.current.notice).toBeNull();
    expect(sessionStorage.getItem('assistant.active')).toBeNull();
  });

  it('W05 AS-51: a resume that answers 404 shows the finished answer from the history when it is there', async () => {
    const { result } = setup();
    const first = await startReply(result);
    fake.api.history.mockResolvedValue(historyWith('m1'));
    await act(async () => first.end({ terminal: false }));
    const second = await fake.call(1);
    await act(async () => second.fail(new AssistantRejected(404, { code: 'generation_not_found' }, {})));
    await vi.waitFor(() => expect(result.current.running).toBe(false));
    expect(result.current.items.map((m) => m.content)).toEqual(['hi', 'Full answer']);
    expect(result.current.notice).toBeNull();
  });

  // The stream's message id is the turn id; a saved message has an id of its own and carries that turn id in `turnId`.
  const savedTurn = (turnId: string) => ({
    conversation: { id: CONVERSATION_ID, title: 'New chat', updatedAt: '2026-10-17T10:00:00.000Z' },
    messages: [
      { id: 'saved-user-1', turnId, role: 'user' as const, text: 'hi', tools: [] },
      { id: 'saved-answer-1', turnId, role: 'assistant' as const, text: 'Full answer', tools: [] },
    ],
  });

  it('W05 AS-48: a saved message found by its turnId (its own id differs from the stream message id) is read from the history on a 404 resume, shown once', async () => {
    const { result } = setup();
    const first = await startReply(result);
    fake.api.history.mockResolvedValue(savedTurn('m1'));
    await act(async () => first.end({ terminal: false }));
    const second = await fake.call(1);
    await act(async () => second.fail(new AssistantRejected(404, { code: 'generation_not_found' }, {})));
    await vi.waitFor(() => expect(result.current.running).toBe(false));
    expect(result.current.items.map((m) => m.content)).toEqual(['hi', 'Full answer']);
    expect(result.current.notice).toBeNull();
  });

  it('W05 AS-48: a reply already saved in the history (turnId = stream message id, different message ids) is shown once', async () => {
    sessionStorage.setItem('assistant.active', JSON.stringify({ conversationId: CONVERSATION_ID }));
    fake.api.history.mockResolvedValue(savedTurn('m1'));
    const { result } = setup();
    await vi.waitFor(() => expect(result.current.historyState).toBe('ready'));
    await sendText(result, 'hi');
    const call = await fake.call(0);
    act(() => call.emit(META('m1'), '1-0'));
    act(() => call.emit(TEXT('Full answer'), '2-0'));
    act(() => call.emit(DONE(), '3-0'));
    await act(async () => call.end({ terminal: true }));
    expect(result.current.items.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Full answer'],
    ]);
  });

  it('W05 AS-51: a resume that answers 404 with no answer in the history says the reply was interrupted and offers Try again', async () => {
    const { result } = setup();
    const first = await startReply(result);
    fake.api.history.mockResolvedValue(historyWith(null));
    await act(async () => first.end({ terminal: false }));
    const second = await fake.call(1);
    await act(async () => second.fail(new AssistantRejected(404, { code: 'generation_not_found' }, {})));
    await vi.waitFor(() => expect(result.current.running).toBe(false));
    expect(result.current.notice).toMatchObject({ text: 'The reply was interrupted. Ask again to retry.', tryAgain: 'ask' });
    act(() => result.current.tryAgain());
    expect(result.current.input).toBe('hi');
    expect(fake.api.send).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-51: "Try again" after "We couldn\'t reconnect" attaches once more', async () => {
    vi.useFakeTimers();
    const { result } = setup();
    await sendText(result, 'hi');
    await act(async () => vi.advanceTimersByTimeAsync(0));
    act(() => fake.calls[0].emit(META('m1'), '1-0'));
    await act(async () => fake.calls[0].end({ terminal: false }));
    let seen = 1;
    for (let step = 0; step < 140_000 && result.current.running; step += 500) {
      while (fake.calls.length > seen) {
        await act(async () => fake.calls[seen].fail(new TypeError('network error')));
        seen += 1;
      }
      await act(async () => vi.advanceTimersByTimeAsync(500));
    }
    expect(result.current.notice?.tryAgain).toBe('reattach');
    const before = fake.calls.length;
    act(() => result.current.reattach());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fake.calls.length).toBe(before + 1);
    expect(fake.calls[before].args).toEqual(['m1', undefined]);
  });

  it('W05 AS-52: Stop sends one cancel call, shows "Stopping…", keeps reading until CANCELLED and keeps the partial text', async () => {
    const { result } = setup();
    const call = await startReply(result);
    const historyReads = fake.api.history.mock.calls.length;
    act(() => result.current.stop());
    act(() => result.current.stop());
    await vi.waitFor(() => expect(fake.api.cancel).toHaveBeenCalledTimes(1));
    expect(fake.api.cancel).toHaveBeenCalledWith('m1');
    expect(result.current.reply.phase).toBe('stopping');
    expect(result.current.items.at(-1)?.live).toBe('stopping');

    act(() => call.emit({ event: 'error', code: 'CANCELLED' }, '3-0'));
    await act(async () => call.end({ terminal: true }));
    expect(result.current.items.at(-1)?.content).toBe('Hel');
    expect(result.current.notice).toMatchObject({ text: "Stopped. This reply wasn't saved." });
    expect(result.current.running).toBe(false);
    expect(fake.api.history.mock.calls.length).toBe(historyReads);
  });

  it('W05 AS-52: a cancel that answers 409 generation_finished shows the finished answer from the history', async () => {
    const { result } = setup();
    await startReply(result);
    fake.api.cancel.mockRejectedValue(rest(409, 'generation_finished'));
    fake.api.history.mockResolvedValue(historyWith('m1'));
    act(() => result.current.stop());
    await vi.waitFor(() => expect(result.current.running).toBe(false));
    expect(result.current.items.map((m) => m.content)).toEqual(['hi', 'Full answer']);
    expect(result.current.notice).toBeNull();
  });

  it('W05 AS-52: a cancel that answers 404 follows the history path of AS-51', async () => {
    const { result } = setup();
    await startReply(result);
    fake.api.cancel.mockRejectedValue(rest(404, 'generation_not_found'));
    fake.api.history.mockResolvedValue(historyWith(null));
    act(() => result.current.stop());
    await vi.waitFor(() => expect(result.current.running).toBe(false));
    expect(result.current.notice).toMatchObject({ text: 'The reply was interrupted. Ask again to retry.' });
  });

  it('W05 AS-52: when the server does not end the stream within 5 s of a stop, the local read is aborted', async () => {
    vi.useFakeTimers();
    const { result } = setup();
    await sendText(result, 'hi');
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const call = fake.calls[0];
    act(() => call.emit(META('m1'), '1-0'));
    await act(async () => result.current.stop());
    expect(result.current.reply.phase).toBe('stopping');
    await act(async () => vi.advanceTimersByTimeAsync(4900));
    expect(result.current.running).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(call.aborted()).toBe(true);
    expect(result.current.running).toBe(false);
    expect(result.current.notice).toMatchObject({ text: "Stopped. This reply wasn't saved." });
  });

  it('W05 AS-54: a send answered 409 idempotency_in_flight attaches to that reply from the start, with no second turn', async () => {
    const { result } = setup();
    await sendText(result, 'hi');
    const first = await fake.call(0);
    await act(async () => first.fail(new AssistantRejected(409, { code: 'idempotency_in_flight', messageId: 'm9' }, {})));
    const second = await fake.call(1);
    expect(second.kind).toBe('resume');
    expect(second.args).toEqual(['m9', undefined]);
    act(() => second.emit(META('m9'), '1-0'));
    act(() => second.emit(TEXT('attached'), '2-0'));
    act(() => second.emit(DONE(), '3-0'));
    await act(async () => second.end({ terminal: true }));
    expect(result.current.items.map((m) => m.content)).toEqual(['hi', 'attached']);
    expect(fake.api.send).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-54: a replayed finished turn (Idempotent-Replay) is shown once as an ordinary reply', async () => {
    const { result } = setup();
    await sendText(result, 'hi');
    const call = await fake.call(0);
    act(() => call.emit(META('m1'), '1-0'));
    act(() => call.emit(TEXT('Stored answer'), '2-0'));
    act(() => call.emit(DONE(), '3-0'));
    await act(async () => call.end({ terminal: true, replayed: true }));
    expect(result.current.items.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(result.current.items.at(-1)?.content).toBe('Stored answer');
    expect(result.current.notice).toBeNull();
  });

  it('W05 AS-54: a 422 idempotency_key_reuse starts again with a new key', async () => {
    const { result } = setup();
    await sendText(result, 'hi');
    const first = await fake.call(0);
    await act(async () => first.fail(new AssistantRejected(422, { code: 'idempotency_key_reuse' }, {})));
    const second = await fake.call(1);
    expect(second.kind).toBe('send');
    expect(keyOf(1)).not.toBe(keyOf(0));
    expect((second.args[1] as { text: string }).text).toBe('hi');
  });

  describe('W05 AS-60: a 401 runs the session-ended flow once and keeps the partial reply', () => {
    let ended: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      ended = vi.fn();
      rearmSessionEnd();
      setSessionEndHandler(ended);
    });
    afterEach(() => setSessionEndHandler(null));

    it('on send', async () => {
      const { result } = setup();
      await sendText(result, 'hi');
      const call = await fake.call(0);
      await act(async () => call.fail(new AssistantRejected(401, { code: 'unauthenticated' }, {})));
      expect(ended).toHaveBeenCalledTimes(1);
      expect(fake.api.send).toHaveBeenCalledTimes(1);
      expect(result.current.notice).toBeNull();
    });

    it('on resume', async () => {
      const { result } = setup();
      const first = await startReply(result);
      await act(async () => first.end({ terminal: false }));
      const second = await fake.call(1);
      await act(async () => second.fail(new AssistantRejected(401, { code: 'unauthenticated' }, {})));
      expect(ended).toHaveBeenCalledTimes(1);
      expect(result.current.items.at(-1)?.content).toBe('Hel');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fake.api.resume).toHaveBeenCalledTimes(1);
    });

    it('on cancel', async () => {
      const { result } = setup();
      await startReply(result);
      fake.api.cancel.mockRejectedValue(rest(401, 'unauthenticated'));
      act(() => result.current.stop());
      await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
      expect(result.current.items.at(-1)?.content).toBe('Hel');
    });

    it('on history and usage', async () => {
      fake.api.history.mockRejectedValue(rest(401, 'unauthenticated'));
      fake.api.usage.mockRejectedValue(rest(401, 'unauthenticated'));
      sessionStorage.setItem('assistant.active', JSON.stringify({ conversationId: CONVERSATION_ID }));
      setup();
      await vi.waitFor(() => expect(ended).toHaveBeenCalled());
      expect(ended).toHaveBeenCalledTimes(1);
    });
  });
});
