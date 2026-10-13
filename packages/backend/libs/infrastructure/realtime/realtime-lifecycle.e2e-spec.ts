import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
} from '@app/test/utils/realtime-app';
import { openSse, type OpenSse } from '@app/test/utils/sse-client';
import {
  StreamAuthenticatorRegistry,
  StreamInvalidCredentialError,
} from './stream/stream-authenticator';

const closed = (reason: string) =>
  MetricsRegistry.value('realtime_connections_closed_total', { reason }) ?? 0;

/** S51 US7 (AS-50 to AS-53): heartbeat, jittered retry, bounded lifetime and a spread-out drain. */
describe('S51 lifecycle (LIFE)', () => {
  const open: OpenSse[] = [];
  const track = async (url: string, headers: Record<string, string> = {}) => {
    const stream = await openSse(url, { headers });
    open.push(stream);
    return stream;
  };
  afterEach(() => {
    while (open.length) open.pop()!.close();
    jest.restoreAllMocks();
  });

  describe('heartbeat and retry', () => {
    let rt: RealtimeTestApp;
    beforeAll(async () => {
      rt = await createRealtimeApp({
        config: { heartbeatMs: 100, maxConnectionsPerAddress: 1_000 },
      });
    });
    afterAll(async () => {
      await rt.close();
    });

    it('S51 AS-50: an idle connection gets `: ping` comments that are not events, and no timer remains after close', async () => {
      const stream = await track(rt.url(`stream:${freshId()}`));
      await stream.waitFor(
        (frames) =>
          frames.filter((f) => f.comments.includes('ping')).length >= 2,
        250,
      );
      expect(stream.events).toHaveLength(0);

      const before = closed('client');
      stream.close();
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5_000;
        const poll = () =>
          closed('client') > before
            ? resolve()
            : Date.now() > deadline
              ? reject(new Error('connection not released'))
              : setTimeout(poll, 10);
        poll();
      });
      expect(MetricsRegistry.value('realtime_connections')).toBe(0);
    });

    it('S51 AS-51: the first frame of 200 connections carries a retry in 2000..5000 and the values are spread', async () => {
      const streams = await Promise.all(
        Array.from({ length: 200 }, () => track(rt.url(`stream:${freshId()}`))),
      );
      await Promise.all(
        streams.map((s) =>
          s.waitFor((f) => f.some((x) => x.retry !== undefined)),
        ),
      );
      const retries = streams.map((s) => s.retry!);
      for (const retry of retries) {
        expect(Number.isInteger(retry)).toBe(true);
        expect(retry).toBeGreaterThanOrEqual(2000);
        expect(retry).toBeLessThanOrEqual(5000);
      }
      expect(new Set(retries).size).toBeGreaterThan(1);
    });
  });

  describe('lifetime', () => {
    let rt: RealtimeTestApp;
    beforeAll(async () => {
      rt = await createRealtimeApp({ config: { maxLifetimeMs: 1_000 } });
    });
    afterAll(async () => {
      await rt.close();
    });

    it('S51 AS-52: the response ends cleanly at the maximum lifetime and a reconnect from the cursor loses nothing', async () => {
      const topic = `stream:${freshId()}` as const;
      const first = await track(rt.url(topic));
      await first.waitFor((f) => f.some((x) => x.retry !== undefined));
      const before = closed('lifetime');
      await rt.publisher.publish(topic, 'tick', { n: 1 });
      await first.waitFor((f) => f.some((x) => x.event === 'tick'));
      const cursor = first.events.at(-1)!.id!;

      await first.waitForEnd(3_000);
      expect(first.complete).toBe(true);
      expect(first.partial).toBe('');
      expect(closed('lifetime')).toBe(before + 1);

      await rt.publisher.publish(topic, 'tick', { n: 2 });
      const second = await track(rt.url(topic), { 'last-event-id': cursor });
      await second.waitFor((f) => f.some((x) => x.event === 'tick'));
      expect(JSON.parse(second.events[0].data!).data).toEqual({ n: 2 });
    });

    it('S51 AS-52: a connection ends at the credential expiry when it is sooner than the lifetime, and the reconnect answers 401', async () => {
      const rtLong = await createRealtimeApp({
        keepStore: true,
        config: { maxLifetimeMs: 60_000 },
      });
      try {
        const registryLong = rtLong.app.get(StreamAuthenticatorRegistry);
        let n = 0;
        jest
          .spyOn(registryLong, 'authenticate')
          .mockImplementation(async () => {
            n += 1;
            if (n > 1) throw new StreamInvalidCredentialError();
            return {
              userId: 'expiring-user',
              roles: [],
              credentialExpiresAt: rtLong.clock.now().getTime() + 300,
            };
          });
        const started = Date.now();
        const stream = await openSse(rtLong.url(`stream:${freshId()}`));
        open.push(stream);
        await stream.waitForEnd(3_000);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(stream.complete).toBe(true);

        const again = await openSse(rtLong.url(`stream:${freshId()}`));
        expect(again.status).toBe(401);
      } finally {
        await rtLong.close();
      }
    });
  });

  describe('shutdown', () => {
    let rt: RealtimeTestApp;
    beforeAll(async () => {
      rt = await createRealtimeApp({
        config: { drainMs: 1_000, maxConnectionsPerAddress: 1_000 },
      });
    });
    afterAll(async () => {
      await rt.close();
    });

    it('S51 AS-53: shutdown ends 100 connections spread over the drain window, with complete frames and every subscription released', async () => {
      const streams = await Promise.all(
        Array.from({ length: 100 }, () => track(rt.url(`stream:${freshId()}`))),
      );
      await Promise.all(
        streams.map((s) =>
          s.waitFor((f) => f.some((x) => x.retry !== undefined)),
        ),
      );
      const endedAt: number[] = [];
      const started = Date.now();
      for (const s of streams)
        void s.waitForEnd(5_000).then(() => endedAt.push(Date.now() - started));

      const registry = rt.app.get(ShutdownRegistry);
      const result = await registry.run('drain');
      expect(result.failed).toEqual([]);
      await Promise.all(streams.map((s) => s.waitForEnd(5_000)));

      expect(endedAt).toHaveLength(100);
      expect(Math.max(...endedAt)).toBeLessThan(2_500);
      // spread: not everything at the same instant
      expect(Math.max(...endedAt) - Math.min(...endedAt)).toBeGreaterThan(200);
      for (const s of streams) {
        expect(s.complete).toBe(true);
        expect(s.partial).toBe('');
      }
      expect(rt.hub.listenerCount()).toBe(0);
      expect(MetricsRegistry.value('realtime_connections')).toBe(0);
      // a new request during the drain is refused rather than served
      const late = await openSse(rt.url(`stream:${freshId()}`));
      expect(late.status).toBe(503);
    });
  });
});
