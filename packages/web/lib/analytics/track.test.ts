import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/events', () => ({ sendEvents: vi.fn() }));

import { sendEvents } from '@/lib/api/events';
import { __resetTrackForTests, track } from './track';

const send = vi.mocked(sendEvents);
const ok = { ok: true } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Sent = Parameters<typeof sendEvents>[0];
const batches = (): Sent[] => send.mock.calls.map((call) => call[0]);

function clearCookies() {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

function setPrivacy(signal: 'gpc' | 'dnt' | 'none') {
  Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: signal === 'gpc' ? true : undefined });
  Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: signal === 'dnt' ? '1' : null });
}

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  send.mockReset();
  send.mockResolvedValue(ok);
  clearCookies();
  setPrivacy('none');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  __resetTrackForTests();
});

afterEach(() => {
  __resetTrackForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('track', () => {
  it('W02 AS-67: an event has an id, name, anonymous id, timestamp, page without query or fragment, and props', async () => {
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    track({ name: 'product_view', page: '/products/abc?tab=pickup#x', props: { product_id: 'abc', category: 'audio' } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
    const [event] = batches()[0];
    expect(event.event_id).toMatch(UUID);
    expect(event.name).toBe('product_view');
    expect(event.anonymous_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(event.ts).toBe(Date.parse('2026-10-11T12:00:00Z'));
    expect(event.page).toBe('/products/abc');
    expect(event.props).toEqual({ product_id: 'abc', category: 'audio' });
  });

  it('W02 AS-68: accepts the page_view shape of the app shell and defaults the page to the current path', async () => {
    track({ name: 'page_view', page: '/search?q=secret' });
    track({ name: 'page_view' });
    await vi.advanceTimersByTimeAsync(5000);
    const events = batches()[0];
    expect(events[0]).toMatchObject({ name: 'page_view', page: '/search' });
    expect(events[1]).toMatchObject({ name: 'page_view', page: window.location.pathname });
    expect(events[0].props).toBeUndefined();
  });

  it('W02 AS-67: props are flat, at most 30 entries, keys [A-Za-z0-9_.-]{1,64}, values string<=500 | number | boolean', async () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    track({ name: 'click', props: { ...many, 'bad key': 'x', ['k'.repeat(65)]: 'x', ok_key: 'v', 'a.b-c_d': true, long: 'x'.repeat(600), nan: Number.NaN, inf: Infinity, nested: { a: 1 } as never, arr: [1] as never, nul: null as never } });
    await vi.advanceTimersByTimeAsync(5000);
    const props = batches()[0][0].props!;
    expect(Object.keys(props).length).toBeLessThanOrEqual(30);
    for (const [key, value] of Object.entries(props)) {
      expect(key).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
      expect(['string', 'number', 'boolean']).toContain(typeof value);
      if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(500);
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
    expect(props).not.toHaveProperty('bad key');
    expect(props).not.toHaveProperty('nested');
    expect(props).not.toHaveProperty('arr');
    expect(props).not.toHaveProperty('nul');
    expect(props).not.toHaveProperty('nan');
  });

  it('W02 AS-67: an event with an unknown name is dropped and creates no cookie', async () => {
    track({ name: 'purchase' as never });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain('anonymous_id');
  });

  it('W02 AS-77: no search text, question, discussion text or coordinates reach an event', async () => {
    track({
      name: 'search',
      page: '/search?q=iphone',
      props: { q: 'iphone', query: 'iphone', search_text: 'x', question: 'why', text: 'hello', lat: 52.5, lng: 13.4, latitude: 1, longitude: 2, coords: '1,2', results: 24, semantic: true },
    });
    await vi.advanceTimersByTimeAsync(5000);
    const [event] = batches()[0];
    expect(event.props).toEqual({ results: 24, semantic: true });
    expect(JSON.stringify(event)).not.toMatch(/iphone|52\.5|why|hello/);
  });
});

describe('track delivery', () => {
  it('W02 AS-68: events wait for the 5 second flush', async () => {
    track({ name: 'click' });
    await vi.advanceTimersByTimeAsync(4999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ beacon: false }));
  });

  it('W02 AS-68: the 20th queued event sends a batch of 20 at once', async () => {
    for (let i = 0; i < 19; i++) track({ name: 'click', props: { i } });
    expect(send).not.toHaveBeenCalled();
    track({ name: 'click', props: { i: 19 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(batches()[0]).toHaveLength(20);
  });

  it('W02 AS-68: a batch holds at most 20; the rest follows on the timer', async () => {
    for (let i = 0; i < 25; i++) track({ name: 'click', props: { i } });
    await vi.advanceTimersByTimeAsync(0);
    expect(batches().map((batch) => batch.length)).toEqual([20]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches().map((batch) => batch.length)).toEqual([20, 5]);
  });

  it('W02 AS-68: hiding the page sends what is queued by beacon', async () => {
    track({ name: 'click' });
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.any(Array), { beacon: true });
  });

  it('W02 AS-68: pagehide also sends by beacon, and an empty queue sends nothing', async () => {
    window.dispatchEvent(new Event('pagehide'));
    track({ name: 'click' });
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.any(Array), { beacon: true });
  });

  it('W02 AS-68: a failed batch is retried after 1, 2 and 4 seconds with the same event ids, then dropped', async () => {
    send.mockResolvedValue({ ok: false, retryable: true });
    track({ name: 'click' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(send).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(4);
    const ids = batches().map((batch) => batch.map((event) => event.event_id));
    expect(new Set(ids.map((list) => list.join())).size).toBe(1);
  });

  it('W02 AS-68: a retry that succeeds stops retrying', async () => {
    send.mockResolvedValueOnce({ ok: false, retryable: true }).mockResolvedValue(ok);
    track({ name: 'click' });
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('W02 AS-68: a rejection that cannot succeed is not retried', async () => {
    send.mockResolvedValue({ ok: false, retryable: false });
    track({ name: 'click' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('W02 AS-68: a sender that throws is treated as a retryable failure and never reaches the caller', async () => {
    send.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(ok);
    expect(() => track({ name: 'click' })).not.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('W02 AS-68: tracking returns at once; sending is never awaited by the caller', () => {
    send.mockReturnValue(new Promise(() => {}));
    expect(track({ name: 'click' })).toBeUndefined();
  });
});

describe('track identity and privacy', () => {
  it('W02 AS-68: the anonymous id is a first-party cookie created once, 22 characters, one year, SameSite=Lax', async () => {
    const writes: string[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    const setter = vi.spyOn(Document.prototype, 'cookie', 'set').mockImplementation(function (this: Document, value: string) {
      writes.push(value);
      descriptor.set!.call(this, value);
    });
    track({ name: 'click' });
    track({ name: 'click' });
    await vi.advanceTimersByTimeAsync(5000);
    setter.mockRestore();
    const creations = writes.filter((write) => write.startsWith('anonymous_id='));
    expect(creations).toHaveLength(1);
    expect(creations[0]).toMatch(/^anonymous_id=[A-Za-z0-9_-]{22}; /);
    expect(creations[0]).toContain('Max-Age=31536000');
    expect(creations[0]).toContain('SameSite=Lax');
    expect(creations[0]).toContain('Path=/');
    const [first, second] = batches()[0];
    expect(first.anonymous_id).toBe(second.anonymous_id);
  });

  it('W02 AS-68: an existing valid cookie is reused; a malformed one is replaced', async () => {
    document.cookie = 'anonymous_id=abcdefghijklmnopqrstuv; Path=/';
    track({ name: 'click' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches()[0][0].anonymous_id).toBe('abcdefghijklmnopqrstuv');

    send.mockClear();
    __resetTrackForTests();
    document.cookie = 'anonymous_id=short; Path=/';
    track({ name: 'click' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches()[0][0].anonymous_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(batches()[0][0].anonymous_id).not.toBe('short');
  });

  it('W02 AS-68: ids differ between visitors', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      clearCookies();
      __resetTrackForTests();
      send.mockClear();
      track({ name: 'click' });
      await vi.advanceTimersByTimeAsync(5000);
      seen.add(batches()[0][0].anonymous_id);
    }
    expect(seen.size).toBe(20);
  });

  it('W02 AS-68: Global Privacy Control creates no cookie and queues no event', async () => {
    setPrivacy('gpc');
    track({ name: 'product_view', props: { product_id: 'p' } });
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain('anonymous_id');
  });

  it('W02 AS-68: Do Not Track creates no cookie and queues no event', async () => {
    setPrivacy('dnt');
    track({ name: 'product_view', props: { product_id: 'p' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain('anonymous_id');
  });

  it('W02 AS-68: a signal switched on later stops what is not yet sent', async () => {
    track({ name: 'click' });
    setPrivacy('gpc');
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).not.toHaveBeenCalled();
  });

  it('W02 AS-68: a reset forgets queued events and pending timers', async () => {
    track({ name: 'click' });
    __resetTrackForTests();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).not.toHaveBeenCalled();
  });
});
