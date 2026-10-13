import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventStream } from './sse';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (e: MessageEvent) => void>();
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }
  emit(type: string, payload: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

describe('createEventStream (S51 client contract)', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('S51 client G-32: resync and revoked reach the handler even when the page did not list them in `types`', () => {
    const seen: Array<[string, string, unknown]> = [];
    createEventStream(['auction:a1'], ['price'], (topic, type, data) => seen.push([topic, type, data]));
    const es = FakeEventSource.instances[0];
    es.emit('price', { topic: 'auction:a1', data: { n: 1 } });
    es.emit('resync', { topic: 'auction:a1', data: { reason: 'replay-gap' } });
    es.emit('revoked', { topic: 'auction:a1', data: {} });
    expect(seen).toEqual([
      ['auction:a1', 'price', { n: 1 }],
      ['auction:a1', 'resync', { reason: 'replay-gap' }],
      ['auction:a1', 'revoked', {}],
    ]);
  });

  it('S51 client G-32: after a final failure (401/403 close the EventSource) the stream is recreated with backoff, and close() stops that', () => {
    const stream = createEventStream(['user:u1'], ['notification'], () => undefined);
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0].fail();
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].init).toEqual({ withCredentials: true });

    FakeEventSource.instances[1].fail();
    stream.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});
