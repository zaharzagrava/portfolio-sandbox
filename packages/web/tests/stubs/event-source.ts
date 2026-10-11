/**
 * Controllable `EventSource` for jsdom (W03 T003, gaps T5). jsdom has none. `installEventSourceStub()` replaces
 * `globalThis.EventSource`; the test then drives the connection:
 *
 *   const sources = installEventSourceStub();
 *   ... code under test opens `new EventSource(url)` ...
 *   sources.last().open();
 *   sources.last().emit('order.status', { orderId, status, orderVersion });
 *   sources.last().fail(); // connection error, the browser would retry (readyState CONNECTING)
 *   sources.last().refuse(); // final failure, readyState CLOSED (401/403 or a non-event-stream answer)
 *
 * Named events reach listeners added with `addEventListener(name, ...)`; a frame without a name reaches `onmessage`.
 */

type Listener = (event: Event | MessageEvent) => void;

export class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;

  readonly url: string;
  readonly withCredentials: boolean;
  readyState: number = StubEventSource.CONNECTING;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  closeCount = 0;
  private listeners = new Map<string, Set<Listener>>();
  private onClose: (source: StubEventSource) => void;

  constructor(url: string | URL, init: EventSourceInit | undefined, onClose: (source: StubEventSource) => void) {
    this.url = String(url);
    this.withCredentials = init?.withCredentials ?? false;
    this.onClose = onClose;
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    this.dispatch(event.type, event);
    return true;
  }

  close(): void {
    if (this.readyState !== StubEventSource.CLOSED) this.closeCount += 1;
    this.readyState = StubEventSource.CLOSED;
    this.onClose(this);
  }

  /** The connection is established. */
  open(): void {
    this.readyState = StubEventSource.OPEN;
    this.dispatch('open', new Event('open'));
  }

  /** A server frame. A string `data` is sent as is; anything else as JSON. `type` omitted means the default `message`. */
  emit(type: string | null, data: unknown, lastEventId = ''): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.dispatch(type ?? 'message', new MessageEvent(type ?? 'message', { data: payload, lastEventId }));
  }

  /** A transient error: the browser keeps the object and reconnects (readyState CONNECTING). */
  fail(): void {
    if (this.readyState === StubEventSource.CLOSED) return;
    this.readyState = StubEventSource.CONNECTING;
    this.dispatch('error', new Event('error'));
  }

  /** A final error: the browser gave up (e.g. 401/403) and the object is CLOSED. */
  refuse(): void {
    this.readyState = StubEventSource.CLOSED;
    this.dispatch('error', new Event('error'));
  }

  private dispatch(type: string, event: Event | MessageEvent): void {
    const handler = type === 'open' ? this.onopen : type === 'message' ? this.onmessage : type === 'error' ? this.onerror : null;
    handler?.call(this, event);
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener.call(this, event);
  }
}

export type EventSourceStub = {
  /** Every source created since install, oldest first (closed ones included). */
  all: StubEventSource[];
  /** Sources not closed yet. */
  live: () => StubEventSource[];
  last: () => StubEventSource;
  restore: () => void;
};

export function installEventSourceStub(): EventSourceStub {
  const previous = (globalThis as { EventSource?: unknown }).EventSource;
  const all: StubEventSource[] = [];
  const live = new Set<StubEventSource>();
  class Installed extends StubEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init, (source) => live.delete(source));
      all.push(this);
      live.add(this);
    }
  }
  (globalThis as { EventSource?: unknown }).EventSource = Installed;
  return {
    all,
    live: () => [...live],
    last: () => {
      const source = all.at(-1);
      if (!source) throw new Error('No EventSource was created');
      return source;
    },
    restore: () => {
      if (previous === undefined) delete (globalThis as { EventSource?: unknown }).EventSource;
      else (globalThis as { EventSource?: unknown }).EventSource = previous;
    },
  };
}
