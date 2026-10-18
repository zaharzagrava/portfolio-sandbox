import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chunkedResponse, controlledStream, problemResponse, sseFrame } from '../../tests/support/chunked-stream';
import { server } from '../../vitest.setup';
import { assistantApi, assistantProblem, AssistantRejected, type AssistantStreamEvent } from './assistant';
import { problemFromError } from './errors';
import { ApiParseError } from './parse';

const sse = (...frames: string[]) => new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const frame = (id: string, event: string, data: unknown) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const origin = 'http://localhost:3000';
const CONVERSATION = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const done = { stopReason: 'end_turn', truncated: false, usage: { inputTokens: 1, outputTokens: 2 }, allowance: { used: 3, limit: 4 } };
const noop = { onEvent: () => undefined };

describe('Assistant API client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('S46 AS-63: sends the Idempotency-Key as a header, never in the body, and returns the resume cursor', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sse(frame('1-0', 'meta', { messageId: 'm1', conversationId: 'c1' }), frame('2-0', 'text', { t: 'Hel' }), frame('3-0', 'done', done)),
    );
    const events: string[] = [];
    const result = await assistantApi.send('c1', { text: 'hi', key: 'key-1' }, { onEvent: (e) => events.push(e.event) });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/assistant/conversations/c1/messages');
    expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBe('key-1');
    expect(JSON.parse(init?.body as string)).toEqual({ text: 'hi' });
    expect(events).toEqual(['meta', 'text', 'done']);
    expect(result).toEqual({ terminal: true, lastEventId: '3-0' });
  });

  it('S46 AS-22: resumes after the last event id', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse(frame('13-0', 'text', { t: 'x' })));
    const result = await assistantApi.resume('m1', '12-0', { onEvent: () => undefined });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/assistant/messages/m1/stream');
    expect(init).toMatchObject({ method: 'GET' });
    expect((init?.headers as Record<string, string>)['Last-Event-ID']).toBe('12-0');
    expect(result).toEqual({ terminal: false, lastEventId: '13-0' });
  });

  it('S46 AS-66: a send refused before a stream opens rejects with the problem code, extra fields and Retry-After', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'quota_exceeded', used: 5, limit: 5, resetsAt: '2026-11-01T00:00:00.000Z' }), {
        status: 429,
        headers: { 'retry-after': '3600', 'content-type': 'application/problem+json' },
      }),
    );
    const error = await assistantApi.send('c1', { text: 'hi', key: 'k' }, { onEvent: () => undefined }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssistantRejected);
    expect((error as AssistantRejected).response).toEqual({
      status: 429,
      data: { code: 'quota_exceeded', used: 5, limit: 5, resetsAt: '2026-11-01T00:00:00.000Z' },
      headers: { 'retry-after': '3600' },
    });
  });

  it('W05 AS-67 UA8: stream requests are relative, carry the session cookie and the CSRF proof, and never an Authorization header', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sse(frame('1-0', 'text', { t: 'x' })));
    await assistantApi.send('c1', { text: 'hi', key: 'k' }, noop);
    await assistantApi.resume('m1', '1-0', noop);
    for (const [url, init] of spy.mock.calls) {
      expect(String(url)).toMatch(/^\/api\/assistant\//);
      expect(init).toMatchObject({ credentials: 'include' });
      const names = Object.keys(init?.headers as Record<string, string>).map((name) => name.toLowerCase());
      expect(names).not.toContain('authorization');
    }
    expect((spy.mock.calls[0][1]?.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok');
  });

  it('W05 AS-42 UA8: the send location travels in the body only when given', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sse(frame('1-0', 'done', done)));
    await assistantApi.send('c1', { text: 'near me', key: 'k', lat: 52.5, lng: 13.4 }, noop);
    expect(JSON.parse(spy.mock.calls[0][1]?.body as string)).toEqual({ text: 'near me', lat: 52.5, lng: 13.4 });
  });

  it('W05 AS-49 UA8: a Last-Event-ID that is not a stream id is never sent (the server would answer 400 invalid_last_event_id)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sse());
    await assistantApi.resume('m1', 'not-an-id', noop);
    await assistantApi.resume('m1', undefined, noop);
    for (const [, init] of spy.mock.calls) expect(Object.keys(init?.headers as Record<string, string>)).not.toContain('Last-Event-ID');
  });

  it('W05 AS-70 UA8: an unknown event name is skipped and the stream goes on to its end', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sse(frame('1-0', 'meta', { messageId: 'm1', conversationId: 'c1' }), frame('2-0', 'mystery', { a: 1 }), frame('3-0', 'text', { t: 'late' }), frame('4-0', 'done', done)),
    );
    const events: AssistantStreamEvent[] = [];
    const result = await assistantApi.send('c1', { text: 'hi', key: 'k' }, { onEvent: (e) => events.push(e) });
    expect(events.map((e) => e.event)).toEqual(['meta', 'text', 'done']);
    expect(result).toEqual({ terminal: true, lastEventId: '4-0' });
  });

  it('W05 AS-70 UA8: data that is not JSON is skipped, never shown and never ends the stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse('id: 1-0\nevent: text\ndata: {not json\n\n', frame('2-0', 'text', { t: 'ok' }), frame('3-0', 'done', done)));
    const events: AssistantStreamEvent[] = [];
    const result = await assistantApi.send('c1', { text: 'hi', key: 'k' }, { onEvent: (e) => events.push(e) });
    expect(events).toEqual([{ event: 'text', t: 'ok' }, { event: 'done', ...done }]);
    expect(result.terminal).toBe(true);
  });

  it('W05 AS-70 UA8: heartbeat comments between frames are ignored', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse(': ping\n\n', frame('1-0', 'text', { t: 'a' }), ': ping\n\n:\n\n', frame('2-0', 'done', done)));
    const events: string[] = [];
    await assistantApi.send('c1', { text: 'hi', key: 'k' }, { onEvent: (e) => events.push(e.event) });
    expect(events).toEqual(['text', 'done']);
  });

  it('W05 AS-52 UA8: an event whose id does not increase (a repeat of the resume cursor, or an older one) is ignored', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sse(frame('12-0', 'text', { t: 'again' }), frame('13-0', 'text', { t: 'new' }), frame('13-0', 'text', { t: 'twice' }), frame('12-5', 'text', { t: 'older' }), frame('13-1', 'text', { t: 'next' }), frame('100-0', 'text', { t: 'big' })),
    );
    const texts: string[] = [];
    const result = await assistantApi.resume('m1', '12-0', { onEvent: (e) => e.event === 'text' && texts.push(e.t) });
    expect(texts).toEqual(['new', 'next', 'big']);
    expect(result.lastEventId).toBe('100-0');
  });

  it('W05 AS-70 UA8: a known event that breaks the contract schema is the unexpected error (status 500, invalid_response), not data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse(frame('1-0', 'meta', { messageId: 'm1', conversationId: 'c1' }), frame('2-0', 'text', { t: 5 }), frame('3-0', 'text', { t: 'late' })));
    const events: AssistantStreamEvent[] = [];
    const error = await assistantApi.send('c1', { text: 'hi', key: 'k' }, { onEvent: (e) => events.push(e) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiParseError);
    expect(problemFromError(error)).toMatchObject({ status: 500, code: 'invalid_response' });
    expect(events.map((e) => e.event)).toEqual(['meta']);
  });

  it('W05 AS-49 UA8: frames split anywhere across chunks arrive whole, and a cut connection after events ends the read without a terminal event', async () => {
    const whole = frame('1-0', 'meta', { messageId: 'm1', conversationId: 'c1' }) + frame('2-0', 'text', { t: 'Hel' });
    const chunks = [whole.slice(0, 7), whole.slice(7, 40), whole.slice(40, whole.length - 3), whole.slice(whole.length - 3)];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(chunkedResponse(chunks, { drop: 'error' }));
    const events: string[] = [];
    const result = await assistantApi.send('c1', { text: 'hi', key: 'k' }, { onEvent: (e) => events.push(e.event) });
    expect(events).toEqual(['meta', 'text']);
    expect(result).toEqual({ terminal: false, lastEventId: '2-0' });
  });

  it('W05 AS-52 UA8: aborting the read rejects with an AbortError and cancels the stream', async () => {
    const stream = controlledStream();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(stream.response);
    const controller = new AbortController();
    let opened!: () => void;
    const firstEvent = new Promise<void>((resolve) => (opened = resolve));
    const reading = assistantApi.resume('m1', undefined, { signal: controller.signal, onEvent: () => opened() }).catch((e: unknown) => e);
    stream.push(sseFrame('text', { t: 'a' }, '1-0'));
    await firstEvent;
    controller.abort();
    const error = await reading;
    expect((error as Error).name).toBe('AbortError');
  });

  it('W05 AS-54 UA8: a conflict while the same key is still answered rejects with the message id to attach to', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problemResponse(409, { code: 'idempotency_in_flight', messageId: 'm9' }));
    const error = await assistantApi.send('c1', { text: 'hi', key: 'k' }, noop).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssistantRejected);
    expect(assistantProblem(error)).toMatchObject({ status: 409, code: 'idempotency_in_flight', messageId: 'm9' });
  });

  it('W05 AS-54 UA8: a replayed finished turn is flagged from the Idempotent-Replay header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(chunkedResponse([frame('1-0', 'text', { t: 'x' }), frame('2-0', 'done', done)], { headers: { 'idempotent-replay': 'true' } }));
    expect(await assistantApi.send('c1', { text: 'hi', key: 'k' }, noop)).toEqual({ terminal: true, lastEventId: '2-0', replayed: true });
  });

  it('W05 AS-56 UA8: problem extension members are read from the raw body with their types checked', () => {
    const rejected = (data: Record<string, unknown>, headers: Record<string, string> = {}) => new AssistantRejected(400, data, headers);
    expect(assistantProblem(rejected({ code: 'input_rejected', category: 'sensitive_data' }))).toMatchObject({ code: 'input_rejected', category: 'sensitive_data' });
    expect(assistantProblem(rejected({ code: 'quota_exceeded', used: 5, limit: 5, resetsAt: '2026-11-01T00:00:00.000Z' }, { 'retry-after': '90' }))).toMatchObject({
      code: 'quota_exceeded',
      used: 5,
      limit: 5,
      resetsAt: '2026-11-01T00:00:00.000Z',
      retryAfterSeconds: 90,
    });
    const wrong = assistantProblem(rejected({ code: 'quota_exceeded', used: '5', limit: null, resetsAt: 7, category: 1, messageId: {} }));
    expect(wrong.used).toBeUndefined();
    expect(wrong.limit).toBeUndefined();
    expect(wrong.resetsAt).toBeUndefined();
    expect(wrong.category).toBeUndefined();
    expect(wrong.messageId).toBeUndefined();
  });

  it('W05 AS-61 UA8: the conversation list, create, history, usage, cancel and delete use relative URLs and parse with the contract schemas', async () => {
    const conversation = { id: CONVERSATION, title: 'New chat', updatedAt: '2026-10-17T10:00:00.000Z', messageCount: 0 };
    const seen: Request[] = [];
    server.use(
      http.get(`${origin}/api/assistant/conversations`, ({ request }) => (seen.push(request.clone()), HttpResponse.json({ items: [conversation], nextCursor: 'n' }))),
      http.post(`${origin}/api/assistant/conversations`, ({ request }) => (seen.push(request.clone()), HttpResponse.json(conversation, { status: 201 }))),
      http.get(`${origin}/api/assistant/conversations/${CONVERSATION}/messages`, ({ request }) =>
        (seen.push(request.clone()),
        HttpResponse.json({ conversation: { id: CONVERSATION, title: 'T', updatedAt: '2026-10-17T10:00:00.000Z' }, messages: [{ id: 'm1', turnId: 't1', role: 'assistant', text: 'Hi', tools: ['search_products'] }] })),
      ),
      http.get(`${origin}/api/assistant/usage`, () => HttpResponse.json({ used: 10, limit: 100, resetsAt: '2026-11-01T00:00:00.000Z' })),
      http.post(`${origin}/api/assistant/messages/m1/cancel`, ({ request }) => (seen.push(request.clone()), HttpResponse.json({ cancelling: true }, { status: 202 }))),
      http.delete(`${origin}/api/assistant/conversations/${CONVERSATION}`, ({ request }) => (seen.push(request.clone()), new HttpResponse(null, { status: 204 }))),
    );
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
    expect(await assistantApi.listConversations({ limit: 20, cursor: 'c' })).toEqual({ items: [conversation], nextCursor: 'n' });
    expect(new URL(seen[0].url).searchParams.get('limit')).toBe('20');
    expect(new URL(seen[0].url).searchParams.get('cursor')).toBe('c');
    expect((await assistantApi.createConversation()).id).toBe(CONVERSATION);
    const history = await assistantApi.history(CONVERSATION);
    expect(history.messages).toEqual([{ id: 'm1', turnId: 't1', role: 'assistant', text: 'Hi', tools: ['search_products'] }]);
    expect(await assistantApi.usage()).toEqual({ used: 10, limit: 100, resetsAt: '2026-11-01T00:00:00.000Z' });
    await expect(assistantApi.cancel('m1')).resolves.toBeUndefined();
    await expect(assistantApi.deleteConversation(CONVERSATION)).resolves.toBeUndefined();
    for (const request of seen) {
      expect(new URL(request.url).origin).toBe(origin);
      expect(request.headers.get('authorization')).toBeNull();
    }
    expect(seen.filter((request) => request.method !== 'GET').every((request) => request.headers.get('x-csrf-token') === 'tok')).toBe(true);
  });

  it('W05 AS-70 UA8: a conversation, history or usage body that breaks its schema is the unexpected error', async () => {
    server.use(
      http.get(`${origin}/api/assistant/conversations`, () => HttpResponse.json({ items: [{ id: 'x' }], nextCursor: null })),
      http.get(`${origin}/api/assistant/usage`, () => HttpResponse.json({ used: -1 })),
      http.get(`${origin}/api/assistant/conversations/${CONVERSATION}/messages`, () => HttpResponse.json({ messages: 'no' })),
    );
    await expect(assistantApi.listConversations()).rejects.toBeInstanceOf(ApiParseError);
    await expect(assistantApi.usage()).rejects.toBeInstanceOf(ApiParseError);
    await expect(assistantApi.history(CONVERSATION)).rejects.toBeInstanceOf(ApiParseError);
  });

  it('W05 AS-52 UA8: a cancel the server refuses keeps its status and code for the caller (409 generation_finished, 404 generation_not_found)', async () => {
    server.use(
      http.post(`${origin}/api/assistant/messages/done/cancel`, () => HttpResponse.json({ status: 409, code: 'generation_finished' }, { status: 409 })),
      http.post(`${origin}/api/assistant/messages/gone/cancel`, () => HttpResponse.json({ status: 404, code: 'generation_not_found' }, { status: 404 })),
    );
    expect(assistantProblem(await assistantApi.cancel('done').catch((e: unknown) => e))).toMatchObject({ status: 409, code: 'generation_finished' });
    expect(assistantProblem(await assistantApi.cancel('gone').catch((e: unknown) => e))).toMatchObject({ status: 404, code: 'generation_not_found' });
  });
});
