import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installEventSourceStub, type EventSourceStub } from '@/tests/stubs/event-source';
import { sessionApi } from '@/lib/api/session';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { setSessionPresence } from '@/lib/api/session-presence';
import { POLL_OFFSETS_MS } from '@/lib/checkout/polling';
import {
  addTopic,
  claimStreamBanner,
  getUserStreamSnapshot,
  resetUserStream,
  subscribeUserEvents,
  subscribeUserStreamState,
  watchStreamSilence,
  type UserEventHandler,
} from './user-stream';

const USER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ORDER = '7f1c0b1e-8f5e-4d7e-9a53-0d6a5b1f2c01';
const PAYMENT = 'c0a8f6b2-1d3e-4f5a-9b7c-2e4d6f8a0b1c';
const frame = (topic: string, data: unknown) => ({ topic, data });

describe('user stream', () => {
  let es: EventSourceStub;
  const ended = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    es = installEventSourceStub();
    ended.mockClear();
    rearmSessionEnd();
    setSessionEndHandler(ended);
    setSessionPresence(() => true);
  });
  afterEach(() => {
    resetUserStream();
    es.restore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const handler = (over: Partial<UserEventHandler> = {}): UserEventHandler & { onEvent: ReturnType<typeof vi.fn>; onResync: ReturnType<typeof vi.fn>; onRevoked: ReturnType<typeof vi.fn> } =>
    ({ onEvent: vi.fn(), onResync: vi.fn(), onRevoked: vi.fn(), ...over }) as never;

  describe('one connection per page (AS-72)', () => {
    it('W03 AS-72: any number of subscribers share one same-origin EventSource for user:<id> with credentials', () => {
      const a = subscribeUserEvents(handler(), USER);
      const b = subscribeUserEvents(handler(), USER);
      const c = subscribeUserEvents(handler(), USER);
      expect(es.all).toHaveLength(1);
      expect(es.last().url).toBe(`/api/streams?topics=user:${USER}`);
      expect(es.last().withCredentials).toBe(true);
      a();
      b();
      expect(es.live()).toHaveLength(1);
      c();
      expect(es.live()).toHaveLength(0);
      expect(es.all[0].closeCount).toBe(1);
    });

    it('W03 AS-72: unsubscribing twice does not drop another subscriber', () => {
      const a = subscribeUserEvents(handler(), USER);
      subscribeUserEvents(handler(), USER);
      a();
      a();
      expect(es.live()).toHaveLength(1);
    });

    it('W03 AS-72: a new subscription after the last one left opens a fresh connection', () => {
      subscribeUserEvents(handler(), USER)();
      subscribeUserEvents(handler(), USER);
      expect(es.all).toHaveLength(2);
    });
  });

  describe('events', () => {
    it('W03 AS-58: order.status, payment.status and notification reach every handler as {type, data}', () => {
      const first = handler();
      const second = handler();
      subscribeUserEvents(first, USER);
      subscribeUserEvents(second, USER);
      const source = es.last();
      source.open();
      source.emit('order.status', frame(`user:${USER}`, { orderId: ORDER, status: 'PAID', orderVersion: 3 }));
      source.emit('payment.status', frame(`user:${USER}`, { paymentId: PAYMENT, orderId: ORDER, status: 'COMPLETED', version: 2 }));
      const note = { id: PAYMENT, type: 'order', category: 'orders', title: 'Hi', body: 'B', link: null, unread: true, createdAt: '2026-10-11T10:00:00.000Z' };
      source.emit('notification', frame(`user:${USER}`, note));
      for (const h of [first, second]) {
        expect(h.onEvent.mock.calls.map(([e]) => e.type)).toEqual(['order.status', 'payment.status', 'notification']);
        expect(h.onEvent.mock.calls[0][0].data).toEqual({ orderId: ORDER, status: 'PAID', orderVersion: 3 });
      }
    });

    it('W03 AS-58: a payload that breaks the contract and unparsable data are ignored', () => {
      const h = handler();
      subscribeUserEvents(h, USER);
      es.last().open();
      es.last().emit('order.status', frame(`user:${USER}`, { orderId: 'nope', status: 'PAID' }));
      es.last().emit('order.status', 'not json');
      expect(h.onEvent).not.toHaveBeenCalled();
    });

    it('W03 AS-45: resync asks every handler to re-read', () => {
      const h = handler();
      subscribeUserEvents(h, USER);
      es.last().open();
      es.last().emit('resync', frame(`user:${USER}`, { reason: 'replay-gap' }));
      expect(h.onResync).toHaveBeenCalledTimes(1);
      expect(h.onEvent).not.toHaveBeenCalled();
    });

    it('W03 AS-68: revoked drops the topic silently: handlers told, connection closed, no banner', () => {
      const h = handler();
      subscribeUserEvents(h, USER);
      es.last().open();
      es.last().emit('revoked', frame(`user:${USER}`, {}));
      expect(h.onRevoked).toHaveBeenCalledTimes(1);
      expect(es.live()).toHaveLength(0);
      expect(getUserStreamSnapshot().health).toBe('closed');
      const release = claimStreamBanner();
      expect(getUserStreamSnapshot().bannerOwner).not.toBeNull();
      expect(getUserStreamSnapshot().showBanner).toBe(false);
      release();
    });

    it('W03 AS-72: events for added topics reach onTopicEvent with their type', () => {
      const onTopicEvent = vi.fn();
      subscribeUserEvents(handler({ onTopicEvent }), USER);
      addTopic('shop:abc', ['shop.order']);
      es.last().open();
      es.last().emit('shop.order', frame('shop:abc', { n: 1 }));
      expect(onTopicEvent).toHaveBeenCalledWith('shop:abc', 'shop.order', { n: 1 });
    });
  });

  describe('addTopic', () => {
    it('W03 AS-72: adding a topic recreates the connection once with every topic in the URL', () => {
      subscribeUserEvents(handler(), USER);
      es.last().open();
      const remove = addTopic('shop:abc');
      expect(es.all).toHaveLength(2);
      expect(es.all[0].closeCount).toBe(1);
      expect(es.last().url).toBe(`/api/streams?topics=user:${USER},shop:abc`);
      addTopic('shop:abc');
      expect(es.all).toHaveLength(2);
      remove();
      expect(es.all).toHaveLength(2);
      remove();
    });

    it('W03 AS-72: removing the last holder of a topic recreates the connection without it', () => {
      subscribeUserEvents(handler(), USER);
      const remove = addTopic('shop:abc');
      remove();
      expect(es.all).toHaveLength(3);
      expect(es.last().url).toBe(`/api/streams?topics=user:${USER}`);
    });
  });

  describe('health (AS-45)', () => {
    it('W03 AS-45: closed before the first open, connected on open, reconnecting on a transient error, connected again with a re-read', () => {
      const h = handler();
      const changes = vi.fn();
      const stop = subscribeUserStreamState(changes);
      subscribeUserEvents(h, USER);
      expect(getUserStreamSnapshot().health).toBe('closed');
      es.last().open();
      expect(getUserStreamSnapshot().health).toBe('connected');
      es.last().fail();
      expect(getUserStreamSnapshot().health).toBe('reconnecting');
      expect(h.onResync).not.toHaveBeenCalled();
      es.last().open();
      expect(getUserStreamSnapshot().health).toBe('connected');
      expect(h.onResync).toHaveBeenCalledTimes(1);
      expect(changes).toHaveBeenCalled();
      stop();
    });

    it('W03 AS-45: the snapshot is referentially stable between changes', () => {
      subscribeUserEvents(handler(), USER);
      es.last().open();
      expect(getUserStreamSnapshot()).toBe(getUserStreamSnapshot());
    });

    it('W03 AS-45: the banner belongs to one claimant per page, the first to claim it', () => {
      subscribeUserEvents(handler(), USER);
      es.last().open();
      const a = claimStreamBanner();
      const b = claimStreamBanner();
      es.last().fail();
      const snap = getUserStreamSnapshot();
      expect(snap.showBanner).toBe(true);
      expect(snap.bannerOwner).toBe(a.token);
      a();
      expect(getUserStreamSnapshot().bannerOwner).toBe(b.token);
      es.last().open();
      expect(getUserStreamSnapshot().showBanner).toBe(false);
      b();
    });

    it('W03 AS-45: a final refusal refreshes the session once and recreates the stream', async () => {
      const refresh = vi.spyOn(sessionApi, 'refresh').mockResolvedValue({ ok: true, kind: 'session', session: { user: { id: USER, email: null, role: 'USER' }, expiresAt: '2026-10-12T00:00:00.000Z' } });
      subscribeUserEvents(handler(), USER);
      es.last().refuse();
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(es.all).toHaveLength(2);
      expect(es.live()).toHaveLength(1);
      expect(ended).not.toHaveBeenCalled();
      es.last().open();
      es.last().refuse();
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('W03 AS-45: a second refusal without an open in between runs the session-ended flow instead of looping', async () => {
      const refresh = vi.spyOn(sessionApi, 'refresh').mockResolvedValue({ ok: true, kind: 'session', session: { user: { id: USER, email: null, role: 'USER' }, expiresAt: '2026-10-12T00:00:00.000Z' } });
      subscribeUserEvents(handler(), USER);
      es.last().refuse();
      await vi.advanceTimersByTimeAsync(0);
      es.last().refuse();
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(ended).toHaveBeenCalledTimes(1);
      expect(getUserStreamSnapshot().health).toBe('closed');
      expect(es.live()).toHaveLength(0);
    });

    it('W03 AS-45: when the refresh fails, W01 session-ended runs and no new connection is made', async () => {
      vi.spyOn(sessionApi, 'refresh').mockResolvedValue({ ok: false, status: 401, code: 'session_expired' });
      vi.spyOn(sessionApi, 'current').mockResolvedValue({ ok: false, status: 401, code: 'unauthenticated' });
      subscribeUserEvents(handler(), USER);
      es.last().refuse();
      await vi.advanceTimersByTimeAsync(0);
      expect(ended).toHaveBeenCalledTimes(1);
      expect(es.all).toHaveLength(1);
      expect(getUserStreamSnapshot().health).toBe('closed');
    });

    it('W03 AS-45: when the refresh fails but the session read still answers with a member, the stream stays closed and the flow does not run', async () => {
      vi.spyOn(sessionApi, 'refresh').mockResolvedValue({ ok: false, status: 401, code: 'session_expired' });
      const current = vi.spyOn(sessionApi, 'current').mockResolvedValue({ ok: true, kind: 'session', session: { user: { id: USER, email: null, role: 'USER' }, expiresAt: '2026-10-12T00:00:00.000Z' } });
      subscribeUserEvents(handler(), USER);
      es.last().refuse();
      await vi.advanceTimersByTimeAsync(0);
      expect(current).toHaveBeenCalledTimes(1);
      expect(ended).not.toHaveBeenCalled();
      expect(es.all).toHaveLength(1);
      expect(getUserStreamSnapshot().health).toBe('closed');
    });

    it('W03 AS-45: unsubscribing while the refresh is pending creates nothing', async () => {
      let resolve!: (value: Awaited<ReturnType<typeof sessionApi.refresh>>) => void;
      vi.spyOn(sessionApi, 'refresh').mockReturnValue(new Promise((r) => (resolve = r)));
      const off = subscribeUserEvents(handler(), USER);
      es.last().refuse();
      off();
      resolve({ ok: true, kind: 'session', session: { user: { id: USER, email: null, role: 'USER' }, expiresAt: '2026-10-12T00:00:00.000Z' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(es.all).toHaveLength(1);
    });
  });

  describe('polling fallback (AS-39)', () => {
    it('W03 AS-39: silence for 10 seconds starts polling on the 2 s / 5 s schedule, 75 polls, then stops and offers Check again', async () => {
      subscribeUserEvents(handler(), USER);
      es.last().open();
      const poll = vi.fn();
      const watch = watchStreamSilence(poll);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(getUserStreamSnapshot().poll).toBe('idle');
      expect(poll).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(getUserStreamSnapshot().poll).toBe('polling');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(28_000);
      expect(poll).toHaveBeenCalledTimes(15);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(poll).toHaveBeenCalledTimes(POLL_OFFSETS_MS.length);
      expect(getUserStreamSnapshot().poll).toBe('stopped');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(poll).toHaveBeenCalledTimes(POLL_OFFSETS_MS.length);
      watch.stop();
    });

    it('W03 AS-39: never more than 30 polls in any minute', async () => {
      subscribeUserEvents(handler(), USER);
      const times: number[] = [];
      const watch = watchStreamSilence(() => {
        times.push(Date.now());
      });
      await vi.advanceTimersByTimeAsync(10_000 + 340_000);
      expect(times.length).toBe(75);
      const worst = Math.max(...times.map((t) => times.filter((u) => u >= t && u < t + 60_000).length));
      expect(worst).toBeLessThanOrEqual(30);
      watch.stop();
    });

    it('W03 AS-39: Check again restarts the schedule', async () => {
      subscribeUserEvents(handler(), USER);
      const poll = vi.fn();
      const watch = watchStreamSilence(poll);
      await vi.advanceTimersByTimeAsync(10_000 + 330_000);
      expect(getUserStreamSnapshot().poll).toBe('stopped');
      poll.mockClear();
      watch.checkAgain();
      expect(getUserStreamSnapshot().poll).toBe('polling');
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(poll).toHaveBeenCalledTimes(2);
      watch.stop();
    });

    it('W03 AS-39: a stream event while polling stops the polling and waits for another 10 s of silence', async () => {
      subscribeUserEvents(handler(), USER);
      es.last().open();
      const poll = vi.fn();
      const watch = watchStreamSilence(poll);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(poll).toHaveBeenCalledTimes(1);
      es.last().emit('order.status', frame(`user:${USER}`, { orderId: ORDER, status: 'PAID' }));
      expect(getUserStreamSnapshot().poll).toBe('idle');
      await vi.advanceTimersByTimeAsync(9_000);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(poll).toHaveBeenCalledTimes(2);
      watch.stop();
    });

    it('W03 AS-39: events before the 10 s are up keep postponing the fallback', async () => {
      subscribeUserEvents(handler(), USER);
      es.last().open();
      const poll = vi.fn();
      const watch = watchStreamSilence(poll);
      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(8_000);
        es.last().emit('payment.status', frame(`user:${USER}`, { paymentId: PAYMENT, orderId: ORDER, status: 'PENDING', version: i + 1 }));
      }
      expect(poll).not.toHaveBeenCalled();
      expect(getUserStreamSnapshot().poll).toBe('idle');
      watch.stop();
    });

    it('W03 AS-39: stop cancels the schedule and returns the state to idle', async () => {
      subscribeUserEvents(handler(), USER);
      const poll = vi.fn();
      const watch = watchStreamSilence(poll);
      await vi.advanceTimersByTimeAsync(14_000);
      watch.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(poll).toHaveBeenCalledTimes(2);
      expect(getUserStreamSnapshot().poll).toBe('idle');
    });

    it('W03 AS-39: a poll that throws does not stop the schedule', async () => {
      subscribeUserEvents(handler(), USER);
      const poll = vi.fn().mockRejectedValue(new Error('offline'));
      const watch = watchStreamSilence(poll);
      await vi.advanceTimersByTimeAsync(10_000 + 6_000);
      expect(poll).toHaveBeenCalledTimes(3);
      watch.stop();
    });
  });
});
