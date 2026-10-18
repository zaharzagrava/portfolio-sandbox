/**
 * W05 test support (gaps T1, T7): a `Response` whose body arrives chunk by chunk, so reader tests can split a frame in the
 * middle, drop the connection, or hold the stream open and push by hand. Plain `ReadableStream`, no dependency.
 */

const encoder = new TextEncoder();

/** One server-sent frame; `id` is the resume cursor. */
export function sseFrame(event: string, data: unknown, id?: string): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

const sseHeaders = { 'content-type': 'text/event-stream; charset=utf-8' };

/** All chunks delivered in order, then the stream ends cleanly (or errors when `drop: 'error'`). */
export function chunkedResponse(chunks: string[], init: { status?: number; headers?: Record<string, string>; drop?: 'close' | 'error' } = {}): Response {
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) {
        controller.enqueue(encoder.encode(chunks[next++]));
        return;
      }
      if (init.drop === 'error') controller.error(new TypeError('network error'));
      else controller.close();
    },
  });
  return new Response(body, { status: init.status ?? 200, headers: { ...sseHeaders, ...init.headers } });
}

export type ControlledStream = {
  response: Response;
  push: (chunk: string) => void;
  /** The server ends the stream. */
  close: () => void;
  /** The connection is cut under the reader. */
  drop: () => void;
  /** True once the reader cancelled (an abort or `reader.cancel()`). */
  cancelled: () => boolean;
};

/** A stream that stays open until the test pushes, closes or drops it. */
export function controlledStream(init: { status?: number; headers?: Record<string, string> } = {}): ControlledStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  let finished = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { status: init.status ?? 200, headers: { ...sseHeaders, ...init.headers } }),
    push: (chunk) => {
      if (!finished && !cancelled) controller.enqueue(encoder.encode(chunk));
    },
    close: () => {
      if (finished || cancelled) return;
      finished = true;
      controller.close();
    },
    drop: () => {
      if (finished || cancelled) return;
      finished = true;
      controller.error(new TypeError('network error'));
    },
    cancelled: () => cancelled,
  };
}

/** An RFC 9457 problem answer, with the headers a rejection can carry. */
export function problemResponse(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/problem+json', ...headers } });
}
