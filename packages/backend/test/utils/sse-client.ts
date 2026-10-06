import http from 'node:http';

export interface SseEvent {
  id?: string;
  event?: string;
  data?: string;
}

export interface ReadSseOptions {
  headers?: Record<string, string>;
  /** Stop (and disconnect) after this many events. */
  count: number;
  timeoutMs?: number;
  /** POST endpoints that answer with a stream (e.g. the assistant). */
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Stop early once an event of one of these types arrived (end-of-stream markers). */
  until?: string[];
}

/**
 * Minimal SSE reader for e2e specs: opens the stream, collects events until
 * `count` (or an `until` event) arrived or the timeout fired, then aborts the
 * request - which is exactly a client disconnect from the server's view.
 * Non-200 answers resolve with the status and the parsed JSON body.
 */
export function readSse(
  url: string,
  { headers = {}, count, timeoutMs = 10_000, method = 'GET', body, until = [] }: ReadSseOptions,
): Promise<{ status: number; events: SseEvent[]; body?: any }> {
  return new Promise((resolve, reject) => {
    const events: SseEvent[] = [];
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      url,
      {
        method,
        headers: { accept: 'text/event-stream', ...(payload && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (raw += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, events, body: raw ? safeJson(raw) : undefined }));
          return;
        }
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const event: SseEvent = {};
            for (const line of block.split('\n')) {
              if (line.startsWith('id: ')) event.id = line.slice(4);
              else if (line.startsWith('event: ')) event.event = line.slice(7);
              else if (line.startsWith('data: ')) event.data = line.slice(6);
            }
            if (event.data !== undefined) events.push(event);
            if (events.length >= count || (event.event && until.includes(event.event))) {
              req.destroy();
              return resolve({ status: 200, events });
            }
          }
        });
        res.on('end', () => resolve({ status: 200, events }));
      },
    );
    req.on('error', (error) => (events.length ? undefined : reject(error)));
    if (payload) req.write(payload);
    req.end();
    setTimeout(() => {
      req.destroy();
      resolve({ status: 200, events });
    }, timeoutMs);
  });
}

const safeJson = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};
