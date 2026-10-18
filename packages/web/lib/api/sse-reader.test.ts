import { afterEach, describe, expect, it, vi } from 'vitest';
import { chunkedResponse, controlledStream } from '../../tests/support/chunked-stream';
import { SseParser, streamSse } from './sse-reader';

describe('streamSse', () => {
  afterEach(() => vi.restoreAllMocks());

  it('W01 AS-31: authenticates with the cookie session and the CSRF header, never an Authorization header', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('event: done\ndata: {}\n\n', { status: 200 }));
    const events: string[] = [];
    await streamSse('/api/assistant/chat', { body: { q: 1 } }, (e) => events.push(e.event));
    const [, init] = spy.mock.calls[0];
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBe('tok');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(events).toEqual(['done']);
  });

  it('W05 AS-49: a connection cut after the stream opened ends the read quietly; an abort by the caller rejects with an AbortError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(chunkedResponse(['event: text\ndata: {}\n\n', 'event: te'], { drop: 'error' }));
    const events: string[] = [];
    const response = await streamSse('/api/assistant/x', { method: 'GET' }, (e) => events.push(e.event));
    expect(response.ok).toBe(true);
    expect(events).toEqual(['text']);

    const stream = controlledStream();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(stream.response);
    const controller = new AbortController();
    let opened!: () => void;
    const firstEvent = new Promise<void>((resolve) => (opened = resolve));
    const reading = streamSse('/api/assistant/x', { method: 'GET', signal: controller.signal }, () => opened()).catch((e: unknown) => e);
    stream.push('event: text\ndata: {}\n\n');
    await firstEvent;
    controller.abort();
    expect(((await reading) as Error).name).toBe('AbortError');
    expect(stream.cancelled()).toBe(true);
  });

  it('W05 AS-67: no access token is read or sent, and a request refused before a stream opens comes back as the response', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"code":"x"}', { status: 429 }));
    const response = await streamSse('/api/assistant/chat', { body: { q: 1 } }, () => undefined);
    expect(response.status).toBe(429);
    expect(JSON.stringify(spy.mock.calls[0][1]?.headers)).not.toMatch(/bearer|authorization/i);
  });
});

describe('SseParser', () => {
  it('parses named events with ids and JSON data', () => {
    const events = new SseParser().feed('id: 1-0\nevent: text\ndata: {"t":"Hel"}\n\nevent: done\ndata: {}\n\n');
    expect(events).toEqual([
      { id: '1-0', event: 'text', data: '{"t":"Hel"}' },
      { id: undefined, event: 'done', data: '{}' },
    ]);
  });

  it('keeps partial chunks until the event is complete (split mid-line and mid-separator)', () => {
    const parser = new SseParser();
    expect(parser.feed('event: te')).toEqual([]);
    expect(parser.feed('xt\ndata: {"t":"a"}\n')).toEqual([]);
    expect(parser.feed('\nevent: done\r\ndata: {}\r\n\r\n')).toEqual([
      { id: undefined, event: 'text', data: '{"t":"a"}' },
      { id: undefined, event: 'done', data: '{}' },
    ]);
  });

  it('ignores comments/heartbeats and retry lines; defaults the event name; joins multi-line data', () => {
    const events = new SseParser().feed(': ping\n\nretry: 3000\n\ndata: line one\ndata: line two\n\n');
    expect(events).toEqual([{ id: undefined, event: 'message', data: 'line one\nline two' }]);
  });
});
