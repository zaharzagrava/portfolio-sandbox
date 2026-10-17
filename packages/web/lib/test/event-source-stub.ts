import { installEventSourceStub, type EventSourceStub, type StubEventSource } from '@/tests/stubs/event-source';
import { registerStubRestore } from './stub-registry';

/**
 * W04 layer over `tests/stubs/event-source.ts` for the live panel and `subscribeTopic` (test-plan AS-19..AS-25):
 * hub frames `{topic, data}`, in-band `resync` and `revoked`, a final 401/403 refusal, a reconnect, and a connection
 * counter. Restored after every test by the Vitest setup file.
 */

export type LiveStreamStub = EventSourceStub & {
  /** Streams opened since install, closed ones included. */
  opened: () => number;
  /** Streams not closed yet; the page must never hold more than one (AS-25). */
  connections: () => number;
  /** The topics of the newest stream's address, as `topics=a,b` lists them. */
  topics: () => string[];
  /** The browser opened the connection. */
  open: () => void;
  /** A hub frame of `type` for `topic`: `{topic, data}` as the SSE hub sends it. */
  frame: (type: string, topic: string, data: unknown) => void;
  /** The server lost the replay window. */
  resync: () => void;
  /** The server dropped a topic. */
  revoked: (topic: string) => void;
  /** A transient error followed (when `reopen`) by the browser's reconnect. */
  reconnect: (reopen?: boolean) => void;
  /** The browser gave up (401/403 or a wrong content type): the source is CLOSED. */
  refuse: () => void;
};

export function installLiveStreamStub(): LiveStreamStub {
  const base = installEventSourceStub();
  const last = (): StubEventSource => base.last();
  const stub: LiveStreamStub = {
    ...base,
    opened: () => base.all.length,
    connections: () => base.live().length,
    topics: () => decodeURIComponent(new URL(last().url, 'http://localhost').searchParams.get('topics') ?? '').split(',').filter(Boolean),
    open: () => last().open(),
    frame: (type, topic, data) => last().emit(type, { topic, data }),
    resync: () => last().emit('resync', { topic: '*', data: {} }),
    revoked: (topic) => last().emit('revoked', { topic, data: {} }),
    reconnect: (reopen = true) => {
      last().fail();
      if (reopen) last().open();
    },
    refuse: () => last().refuse(),
  };
  registerStubRestore(base.restore);
  return stub;
}
