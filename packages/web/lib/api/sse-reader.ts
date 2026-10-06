import { csrfHeaders, getAccessToken } from './client';

export interface SseEvent {
  id?: string;
  event: string;
  data: string;
}

/**
 * Incremental text/event-stream parser (WHATWG rules we rely on): events end at a blank line, `data:` lines
 * join with "\n", `:` lines are comments (heartbeats), a missing `event:` means "message". Chunks may split
 * anywhere, including inside a line, so unfinished text is kept for the next `feed()`.
 */
export class SseParser {
  private buffer = '';

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n?/g, '\n');
    const events: SseEvent[] = [];
    let end: number;
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event = 'message';
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id') id = value;
      }
      if (data.length) events.push({ id, event, data: data.join('\n') });
    }
    return events;
  }
}

/**
 * POST (or GET) a streaming endpoint and deliver parsed events - for streams EventSource can't open
 * (POST bodies, Authorization header). Resolves when the server ends the stream or `signal` aborts.
 */
export async function streamSse(
  url: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
  onEvent: (event: SseEvent) => void,
): Promise<Response> {
  const token = getAccessToken();
  const res = await fetch(url, {
    method: init.method ?? 'POST',
    credentials: 'include',
    signal: init.signal,
    headers: {
      accept: 'text/event-stream',
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
      ...csrfHeaders(),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok || !res.body) return res;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of parser.feed(decoder.decode(value, { stream: true }))) onEvent(event);
  }
  return res;
}
