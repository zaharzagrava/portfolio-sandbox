import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announceAuth, subscribeAuth } from './session-sync';

type Listener = (event: { data: unknown }) => void;
const channels: FakeChannel[] = [];

class FakeChannel {
  listeners: Listener[] = [];
  closed = false;
  constructor(public name: string) {
    channels.push(this);
  }
  postMessage(data: unknown) {
    // delivered to every other channel of the same name, never to the sender
    for (const other of channels) if (other !== this && other.name === this.name && !other.closed) other.listeners.forEach((l) => l({ data }));
  }
  addEventListener(_type: string, listener: Listener) {
    this.listeners.push(listener);
  }
  removeEventListener(_type: string, listener: Listener) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  close() {
    this.closed = true;
  }
}

describe('session sync', () => {
  beforeEach(() => {
    channels.length = 0;
    vi.stubGlobal('BroadcastChannel', FakeChannel);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('W01 AS-22: a signed-out announcement reaches another tab with only the type', () => {
    const handler = vi.fn();
    const stop = subscribeAuth(handler);
    announceAuth('signed-out');
    expect(handler).toHaveBeenCalledWith('signed-out');
    expect(handler).toHaveBeenCalledTimes(1);
    stop();
  });

  it('W01 AS-22: a signed-in announcement reaches another tab', () => {
    const handler = vi.fn();
    subscribeAuth(handler);
    announceAuth('signed-in');
    expect(handler).toHaveBeenCalledWith('signed-in');
  });

  it('W01 AS-22: ignores messages that are not one of the two types, and stops after unsubscribe', () => {
    const handler = vi.fn();
    const stop = subscribeAuth(handler);
    const [subscriber] = channels;
    subscriber.listeners.forEach((l) => l({ data: { type: 'evil', user: 'x' } }));
    subscriber.listeners.forEach((l) => l({ data: 'signed-out' }));
    expect(handler).not.toHaveBeenCalled();
    stop();
    announceAuth('signed-out');
    expect(handler).not.toHaveBeenCalled();
  });

  it('W01 AS-22: does nothing where BroadcastChannel is unsupported', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(() => announceAuth('signed-out')).not.toThrow();
    expect(() => subscribeAuth(vi.fn())()).not.toThrow();
  });
});
