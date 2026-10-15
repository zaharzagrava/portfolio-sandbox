import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RagStreamEvent } from '@marketplace-sandbox/contracts';
import { askProduct } from './ask';

const PRODUCT = '0192f7a0-0000-7000-8000-00000000c001';
const encoder = new TextEncoder();

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const stream = (...chunks: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
const source = (n: number) => ({ n, chunkId: `c${n}`, documentId: `d${n}`, title: 'Manual', headingPath: 'Manual > Battery', page: null });

async function collect(response: Response, question = 'How long does it last?') {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  const events: RagStreamEvent[] = [];
  await askProduct(PRODUCT, question, { signal: new AbortController().signal, onEvent: (event) => events.push(event) });
  return events;
}

describe('ask stream (lib/api/ask.ts)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('W02 AS-54: SSE parsing: sources items by n, text, done', async () => {
    const events = await collect(
      stream(
        frame('sources', { mode: 'hybrid', items: [source(1), source(2)] }),
        frame('text', { t: 'It lasts ' }),
        frame('text', { t: '40 hours.' }),
        frame('done', { citations: [{ text: 'It lasts 40 hours.', sources: [1] }], grounded: true }),
      ),
    );
    expect(events.map((event) => event.event)).toEqual(['sources', 'text', 'text', 'done']);
    expect(events[0]).toMatchObject({ event: 'sources', mode: 'hybrid', items: [{ n: 1 }, { n: 2 }] });
    expect(events[1]).toEqual({ event: 'text', t: 'It lasts ' });
    expect(events[3]).toMatchObject({ event: 'done', grounded: true });
  });

  it('W02 AS-54: an event split across chunks is delivered once, whole', async () => {
    const events = await collect(stream('event: te', 'xt\ndata: {"t":"He', 'llo"}\n\n'));
    expect(events).toEqual([{ event: 'text', t: 'Hello' }]);
  });

  it('W02 AS-54: posts the trimmed question to the product with Accept, JSON body, the CSRF header and our abort signal, and no Authorization', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
    const controller = new AbortController();
    let signalAborted: boolean | undefined;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      controller.abort(); // the caller's signal is the one the request listens to
      signalAborted = init?.signal?.aborted;
      return stream(frame('not_found', { message: 'x' }));
    });
    await askProduct(PRODUCT, '  Is it waterproof?  ', { signal: controller.signal, onEvent: () => {} });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`/api/products/${PRODUCT}/ask`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(String(init?.body))).toEqual({ question: 'Is it waterproof?' });
    const headers = init?.headers as Record<string, string>;
    expect(headers.accept).toBe('text/event-stream');
    expect(headers['X-CSRF-Token']).toBe('tok');
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('authorization');
    expect(signalAborted).toBe(true);
  });

  it('W02 AS-57: an event whose data is not valid JSON ends the answer as an in-stream error, without throwing', async () => {
    const events = await collect(stream(frame('text', { t: 'Part' }), frame('text', '{not json'), frame('text', { t: 'never' })));
    expect(events).toEqual([
      { event: 'text', t: 'Part' },
      { event: 'error', code: 'INTERNAL' },
    ]);
  });

  it('W02 AS-57: a known event that breaks its schema ends the answer the same way', async () => {
    const events = await collect(stream(frame('done', { grounded: 'yes' })));
    expect(events).toEqual([{ event: 'error', code: 'INTERNAL' }]);
  });

  it('W02 AS-54: an unknown event name is ignored', async () => {
    const events = await collect(stream(frame('heartbeat', { n: 1 }), frame('text', { t: 'ok' })));
    expect(events).toEqual([{ event: 'text', t: 'ok' }]);
  });

  it('W02 AS-57: events after a terminal event are ignored', async () => {
    const events = await collect(stream(frame('not_found', { message: 'm' }), frame('text', { t: 'late' })));
    expect(events.map((event) => event.event)).toEqual(['not_found']);
  });

  it('W02 AS-56: a refused request throws an error that problemFromError reads (status, code, request id, Retry-After)', async () => {
    const response = new Response(JSON.stringify({ code: 'assistant_busy', requestId: 'req-1' }), {
      status: 429,
      headers: { 'content-type': 'application/problem+json', 'retry-after': '7' },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const { problemFromError } = await import('./errors');
    const failure = await askProduct(PRODUCT, 'abc', { signal: new AbortController().signal, onEvent: () => {} }).catch((error: unknown) => error);
    expect(problemFromError(failure)).toEqual({ status: 429, code: 'assistant_busy', errors: [], retryAfterSeconds: 7, requestId: 'req-1' });
  });

  it('W02 AS-56: a network failure is a status 0 problem', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const { problemFromError } = await import('./errors');
    const failure = await askProduct(PRODUCT, 'abc', { signal: new AbortController().signal, onEvent: () => {} }).catch((error: unknown) => error);
    expect(problemFromError(failure).status).toBe(0);
  });

  it('W02 AS-58: aborting the signal rejects with an AbortError the caller can recognise', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const pending = askProduct(PRODUCT, 'abc', { signal: controller.signal, onEvent: () => {} }).catch((error: unknown) => error);
    controller.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
  });
});
