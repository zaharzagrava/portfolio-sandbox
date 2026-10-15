import { afterEach, describe, expect, it, vi } from 'vitest';
import { assistantApi, AssistantRejected, type AssistantStreamEvent } from './assistant';

const sse = (...frames: string[]) => new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const frame = (id: string, event: string, data: unknown) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('assistant stream client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('S46 AS-63: sends the Idempotency-Key as a header, never in the body, and returns the resume cursor', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sse(
        frame('1-0', 'meta', { messageId: 'm1', conversationId: 'c1' }),
        frame('2-0', 'text', { t: 'Hel' }),
        frame('3-0', 'done', { stopReason: 'end_turn', truncated: false, usage: { inputTokens: 1, outputTokens: 2 }, allowance: { used: 3, limit: 4 } }),
      ),
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

  it('ignores an unknown event and treats an event that breaks the contract as a cut stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sse(frame('1-0', 'meta', { messageId: 'm1', conversationId: 'c1' }), frame('2-0', 'mystery', { a: 1 }), frame('3-0', 'text', { t: 5 }), frame('4-0', 'text', { t: 'late' })),
    );
    const events: AssistantStreamEvent[] = [];
    const result = await assistantApi.send('c1', { text: 'hi', key: 'k' }, { onEvent: (e) => events.push(e) });
    expect(events.map((e) => e.event)).toEqual(['meta']);
    expect(result).toEqual({ terminal: false, lastEventId: '1-0' });
  });
});
