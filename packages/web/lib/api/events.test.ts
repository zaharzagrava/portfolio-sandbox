import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/vitest.setup';
import { sendEvents } from './events';

const event = (n = 1) => ({
  event_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: 'product_view' as const,
  anonymous_id: 'AAAAAAAAAAAAAAAAAAAAAA',
  ts: 1_700_000_000_000,
  page: '/products/x',
  props: { product_id: 'p1' },
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'sendBeacon');
  vi.restoreAllMocks();
});

describe('sendEvents', () => {
  it('W02 AS-68: posts the batch as JSON to the same-origin endpoint', async () => {
    let seen: unknown;
    server.use(
      http.post('http://localhost:3000/api/events', async ({ request }) => {
        seen = await request.json();
        return HttpResponse.json({ accepted: 1 }, { status: 202 });
      }),
    );
    expect(await sendEvents([event()])).toEqual({ ok: true });
    expect(seen).toEqual({ events: [event()] });
  });

  it('W02 AS-68: a 202 with rejected items is a success', async () => {
    server.use(http.post('http://localhost:3000/api/events', () => HttpResponse.json({ accepted: 0, rejected: [{ index: 0 }] }, { status: 202 })));
    expect(await sendEvents([event()])).toEqual({ ok: true });
  });

  it.each([
    [500, true],
    [503, true],
    [429, true],
    [408, true],
    [400, false],
    [403, false],
  ])('W02 AS-68: status %i is retryable=%s', async (status, retryable) => {
    server.use(http.post('http://localhost:3000/api/events', () => new HttpResponse(null, { status })));
    expect(await sendEvents([event()])).toEqual({ ok: false, retryable });
  });

  it('W02 AS-68: a network failure is retryable and never throws', async () => {
    server.use(http.post('http://localhost:3000/api/events', () => HttpResponse.error()));
    expect(await sendEvents([event()])).toEqual({ ok: false, retryable: true });
  });

  it('W02 AS-68: on page hide the batch goes by sendBeacon as text/plain', async () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon });
    expect(await sendEvents([event()], { beacon: true })).toEqual({ ok: true });
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0] as unknown as [string, Blob];
    expect(url).toBe('/api/events');
    expect(blob.type.toLowerCase()).toBe('text/plain;charset=utf-8');
    expect(JSON.parse(await blob.text())).toEqual({ events: [event()] });
  });

  it('W02 AS-68: when the browser refuses the beacon a keep-alive request is sent', async () => {
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: vi.fn(() => false) });
    let called = false;
    server.use(
      http.post('http://localhost:3000/api/events', () => {
        called = true;
        return HttpResponse.json({}, { status: 202 });
      }),
    );
    expect(await sendEvents([event()], { beacon: true })).toEqual({ ok: true });
    expect(called).toBe(true);
  });

  it('W02 AS-68: a batch that breaks the contract is dropped without a request', async () => {
    const bad = { ...event(), name: 'not_an_event' } as never;
    expect(await sendEvents([bad])).toEqual({ ok: false, retryable: false });
  });
});
