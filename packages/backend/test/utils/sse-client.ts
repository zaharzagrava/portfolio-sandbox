import http from 'node:http';
import net from 'node:net';

export interface SseEvent {
  id?: string;
  event?: string;
  data?: string;
}

/** One parsed frame: an event, a baseline (`id:` only), a `retry:` frame or a comment (heartbeat). */
export interface SseFrame extends SseEvent {
  raw: string;
  retry?: number;
  comments: string[];
}

const parseFrame = (block: string): SseFrame => {
  const frame: SseFrame = { raw: block, comments: [] };
  for (const line of block.split('\n')) {
    if (line.startsWith('id: ')) frame.id = line.slice(4);
    else if (line.startsWith('event: ')) frame.event = line.slice(7);
    else if (line.startsWith('data: ')) frame.data = line.slice(6);
    else if (line.startsWith('retry: ')) frame.retry = Number(line.slice(7));
    else if (line.startsWith(':')) frame.comments.push(line.slice(1).trim());
  }
  return frame;
};

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

export interface SseResult {
  status: number;
  events: SseEvent[];
  /** Every frame, including baselines, `retry:` and heartbeats (S51 G-29). */
  frames: SseFrame[];
  comments: string[];
  retry?: number;
  headers: http.IncomingHttpHeaders;
  body?: any;
}

/**
 * Minimal SSE reader for e2e specs: opens the stream, collects events until
 * `count` (or an `until` event) arrived or the timeout fired, then aborts the
 * request - which is exactly a client disconnect from the server's view.
 * Non-200 answers resolve with the status and the parsed JSON body.
 */
export function readSse(
  url: string,
  {
    headers = {},
    count,
    timeoutMs = 10_000,
    method = 'GET',
    body,
    until = [],
  }: ReadSseOptions,
): Promise<SseResult> {
  return new Promise((resolve, reject) => {
    const events: SseEvent[] = [];
    const frames: SseFrame[] = [];
    let responseHeaders: http.IncomingHttpHeaders = {};
    const summary = (status: number, parsedBody?: any): SseResult => ({
      status,
      events,
      frames,
      comments: frames.flatMap((f) => f.comments),
      retry: frames.find((f) => f.retry !== undefined)?.retry,
      headers: responseHeaders,
      body: parsedBody,
    });
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      url,
      {
        method,
        headers: {
          accept: 'text/event-stream',
          ...(payload && {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          }),
          ...headers,
        },
      },
      (res) => {
        responseHeaders = res.headers;
        if (res.statusCode !== 200) {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (raw += c));
          res.on('end', () =>
            resolve(
              summary(res.statusCode ?? 0, raw ? safeJson(raw) : undefined),
            ),
          );
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
            const frame = parseFrame(block);
            frames.push(frame);
            if (frame.data !== undefined) events.push(frame);
            if (
              events.length >= count ||
              (frame.event && until.includes(frame.event))
            ) {
              req.destroy();
              return resolve(summary(200));
            }
          }
        });
        res.on('end', () => resolve(summary(200)));
      },
    );
    req.on('error', (error) => (events.length ? undefined : reject(error)));
    if (payload) req.write(payload);
    req.end();
    setTimeout(() => {
      req.destroy();
      resolve(summary(200));
    }, timeoutMs);
  });
}

/** A stream that stays open while the spec acts; `close()` is a client disconnect. */
export interface OpenSse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Parsed JSON problem body when the status is not 200. */
  body?: any;
  frames: SseFrame[];
  events: SseEvent[];
  comments: string[];
  retry?: number;
  /** True once the server ended (or destroyed) the response. */
  readonly ended: boolean;
  /** True when the response ended cleanly (the terminating chunk arrived), not by a reset. */
  readonly complete: boolean;
  /** Bytes received after the last complete frame: empty unless the stream was cut mid-frame. */
  readonly partial: string;
  /** Resolves when `frames` satisfies the predicate; rejects after `timeoutMs` (no fixed sleeps). */
  waitFor(
    predicate: (frames: SseFrame[]) => boolean,
    timeoutMs?: number,
  ): Promise<void>;
  waitForEnd(timeoutMs?: number): Promise<void>;
  /** Stops reading, so the server's writes back up (a slow reader that still has an open connection). */
  pause(): void;
  resume(): void;
  close(): void;
}

/** Resolves once the response headers arrived (or the request failed). */
export function openSse(
  url: string,
  { headers = {} }: { headers?: Record<string, string> } = {},
): Promise<OpenSse> {
  return new Promise((resolve, reject) => {
    const frames: SseFrame[] = [];
    const events: SseEvent[] = [];
    let ended = false;
    const listeners = new Set<() => void>();
    const notify = () => listeners.forEach((l) => l());
    const req = http.request(
      url,
      { method: 'GET', headers: { accept: 'text/event-stream', ...headers } },
      (res) => {
        let buffer = '';
        let raw = '';
        const waitUntil = (
          check: () => boolean,
          timeoutMs: number,
          what: string,
        ) =>
          new Promise<void>((ok, fail) => {
            if (check()) return ok();
            const listener = () => {
              if (!check()) return;
              clearTimeout(timer);
              listeners.delete(listener);
              ok();
            };
            const timer = setTimeout(() => {
              listeners.delete(listener);
              fail(
                new Error(
                  `openSse: ${what} not reached within ${timeoutMs} ms (frames: ${JSON.stringify(frames.map((f) => f.raw))})`,
                ),
              );
            }, timeoutMs);
            listeners.add(listener);
          });
        const handle: OpenSse = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          frames,
          events,
          get comments() {
            return frames.flatMap((f) => f.comments);
          },
          get retry() {
            return frames.find((f) => f.retry !== undefined)?.retry;
          },
          get ended() {
            return ended;
          },
          get complete() {
            return res.complete;
          },
          get partial() {
            return buffer;
          },
          waitFor: (predicate, timeoutMs = 5_000) =>
            waitUntil(() => predicate(frames), timeoutMs, 'frame condition'),
          waitForEnd: (timeoutMs = 5_000) =>
            waitUntil(() => ended, timeoutMs, 'end of stream'),
          pause: () => void res.pause(),
          resume: () => void res.resume(),
          close: () => req.destroy(),
        };
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (res.statusCode !== 200) {
            raw += chunk;
            return;
          }
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = parseFrame(buffer.slice(0, index));
            buffer = buffer.slice(index + 2);
            frames.push(frame);
            if (frame.data !== undefined) events.push(frame);
          }
          notify();
        });
        const finish = () => {
          ended = true;
          if (res.statusCode !== 200)
            handle.body = raw ? safeJson(raw) : undefined;
          notify();
        };
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', finish);
        if (res.statusCode !== 200) {
          res.on('end', () => resolve(handle));
          return;
        }
        resolve(handle);
      },
    );
    req.on('error', (error) => {
      ended = true;
      notify();
      if (!req.destroyed) reject(error);
    });
    req.end();
  });
}

/**
 * A raw TCP client that sends the request and then never reads: the server's writes pile up (slow-consumer and
 * stalled-writer cases, S51 AS-44, AS-45). `close()` destroys the socket.
 */
export function openStalledSocket(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ socket: net.Socket; close: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.pause();
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Accept: text/event-stream',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
      resolve({ socket, close: () => socket.destroy() });
    });
    socket.once('error', reject);
  });
}

const safeJson = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};
