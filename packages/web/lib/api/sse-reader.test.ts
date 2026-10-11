import { afterEach, describe, expect, it, vi } from 'vitest';
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
