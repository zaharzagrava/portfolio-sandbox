import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import { CacheService } from './cache.service';
import { CACHE_TOOLKIT_CONFIG } from './cache.config';
import { DistributedLock } from './distributed-lock';
import { RANDOM_SOURCE } from './random-source';
import { WriteBehindCounter } from './write-behind-counter';
import {
  configFor,
  createCacheInstance,
  Deferred,
  outcomeCount,
  proxyUrl,
  ScriptedRandom,
  startStoreProxy,
  testRedisUrl,
  uniqueNamespace,
} from './testing/cache-fixture.module';

const keyIn = (ns: string, id: string = randomUUID()) => `${ns}:v1:${id}`;
const TOOLKIT_METRICS = [
  'cache_requests_total',
  'cache_loader_calls_total',
  'cache_loader_duration_seconds',
  'cache_invalidations_total',
  'cache_breaker_state',
  'cache_l1_entries',
  'cache_counter_pending_members',
  'cache_lock_acquisitions_total',
];

describe('Cache operations (metrics, logs, shutdown)', () => {
  describe('S52 AS-71: metrics', () => {
    it('S52 AS-71: every outcome and instrument is exposed with namespace/outcome labels only, and label cardinality is bounded by namespaces', async () => {
      const clock = new FakeClock();
      const inst = await createCacheInstance({
        clock,
        random: ScriptedRandom.constant(0.5),
      });
      const proxy = await startStoreProxy();
      const down = await createCacheInstance({
        clock,
        clientUrl: proxyUrl(proxy),
      });
      try {
        const ns = uniqueNamespace();
        const key = (id: string) => keyIn(ns, id);
        const versioned = {
          ttlMs: 600_000,
          jitter: 0,
          versionOf: (d: { version: number }) => d.version,
        };
        const swr = {
          ttlMs: 1_000,
          swrMs: 1_000,
          staleIfErrorMs: 60_000,
          jitter: 0,
        };

        await inst.cache.getOrLoad(key('miss'), async () => 'v', {
          ttlMs: 60_000,
        }); // miss
        await inst.cache.getOrLoad(key('miss'), async () => 'v', {
          ttlMs: 60_000,
        }); // l2
        await inst.cache.getOrLoad(key('l1'), async () => 'v', {
          ttlMs: 60_000,
          l1: 'always',
        });
        await inst.cache.getOrLoad(key('l1'), async () => 'v', {
          ttlMs: 60_000,
          l1: 'always',
        }); // l1
        await inst.cache.getOrLoad(key('neg'), async () => null, {
          ttlMs: 60_000,
          negativeTtlMs: 10_000,
        });
        await inst.cache.getOrLoad(key('neg'), async () => null, {
          ttlMs: 60_000,
          negativeTtlMs: 10_000,
        }); // negative
        await inst.redis.client.set(key('corrupt'), 'garbage');
        await inst.cache.getOrLoad(key('corrupt'), async () => 'v', {
          ttlMs: 60_000,
        }); // corrupt
        await inst.cache.getOrLoad(
          key('big'),
          async () => 'x'.repeat(300 * 1024),
          { ttlMs: 60_000 },
        ); // oversize
        await inst.cache.getOrLoad(key('stale'), async () => 'v1', swr);
        clock.advance(1_001);
        await inst.cache.getOrLoad(key('stale'), async () => 'v2', swr); // stale (+ background refresh)
        await waitFor(async () => inst.cache.stats().pendingRefreshes === 0);
        await inst.cache.getOrLoad(key('err'), async () => 'v1', swr);
        clock.advance(2_001);
        await inst.cache.getOrLoad(
          key('err'),
          async () => {
            throw new Error('down');
          },
          swr,
        ); // stale_error
        await inst.cache.getOrLoad(
          key('ver'),
          async () => ({ version: 1 }),
          versioned,
        );
        await inst.cache.invalidateIfOlder(key('ver'), 3); // applied
        await inst.cache.invalidateIfOlder(key('ver'), 3); // skipped
        await inst.cache.getOrLoad(
          key('ver'),
          async () => ({ version: 1 }),
          versioned,
        ); // refused_below_minimum
        await inst.cache.getOrLoad(key('ver'), async () => ({ version: 1 }), {
          ...versioned,
          versionOf: () => undefined as unknown as number,
        }); // refused_unversioned
        await inst.cache.invalidate([key('miss')]); // ok
        proxy.mode = 'refuse';
        proxy.sever();
        await waitFor(async () => down.redis.client.status !== 'ready');
        await down.cache.getOrLoad(key('down'), async () => 'v', {
          ttlMs: 60_000,
        }); // degraded
        await down.cache.invalidate([key('down')]); // failed
        proxy.mode = 'pass';

        for (const outcome of [
          'l1',
          'l2',
          'miss',
          'negative',
          'stale',
          'stale_error',
          'degraded',
          'corrupt',
          'oversize',
          'refused_below_minimum',
          'refused_unversioned',
        ])
          expect(outcomeCount(ns, outcome)).toBeGreaterThanOrEqual(1);

        expect(
          MetricsRegistry.value('cache_loader_calls_total', { namespace: ns }),
        ).toBeGreaterThan(0);
        expect(
          MetricsRegistry.histogramValue('cache_loader_duration_seconds', {
            namespace: ns,
          })?.count,
        ).toBeGreaterThan(0);
        for (const result of ['ok', 'failed', 'applied', 'skipped'])
          expect(
            MetricsRegistry.value('cache_invalidations_total', { result }),
          ).toBeGreaterThanOrEqual(1);
        expect(MetricsRegistry.value('cache_breaker_state')).toBeDefined();
        expect(MetricsRegistry.value('cache_l1_entries')).toBeDefined();

        const counter = new WriteBehindCounter(
          inst.redis,
          uniqueNamespace('ctr'),
          { clock },
        );
        await counter.increment('m');
        const lock = await new DistributedLock(inst.redis).tryAcquire(
          `${ns}:res`,
          { ttlMs: 1_000 },
        );
        expect(lock).not.toBeNull();
        expect(
          MetricsRegistry.value('cache_lock_acquisitions_total', {
            outcome: 'acquired',
          }),
        ).toBeGreaterThanOrEqual(1);
        expect(
          MetricsRegistry.value('cache_counter_pending_members', {
            counter: (counter as unknown as { name: string }).name,
          }),
        ).toBe(1);

        // Labels: namespace and outcome only, and no key, id or value ever becomes a label value.
        const allowed: Record<string, string[]> = {
          cache_requests_total: ['namespace', 'outcome'],
          cache_loader_calls_total: ['namespace'],
          cache_loader_duration_seconds: ['namespace'],
          cache_invalidations_total: ['result'],
          cache_breaker_state: [],
          cache_l1_entries: [],
          cache_counter_pending_members: ['counter'],
          cache_lock_acquisitions_total: ['outcome'],
        };
        for (const name of TOOLKIT_METRICS)
          for (const labels of MetricsRegistry.labelSets(name)) {
            expect(
              Object.keys(labels).filter((k) => !allowed[name].includes(k)),
            ).toEqual([]);
            for (const value of Object.values(labels))
              expect(String(value)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
          }
        const series = MetricsRegistry.seriesCount('cache_requests_total');
        for (let i = 0; i < 300; i++)
          await inst.cache.getOrLoad(key(`distinct-${i}`), async () => i, {
            ttlMs: 60_000,
          });
        expect(
          MetricsRegistry.seriesCount('cache_requests_total'),
        ).toBeLessThanOrEqual(series + 2);
      } finally {
        await Promise.all([inst.close(), down.close()]);
        await proxy.close();
      }
    });
  });

  describe('S52 AS-72: logs carry no values and no full keys', () => {
    let warn: jest.SpyInstance;
    let proxy: TcpFaultProxy;

    beforeEach(async () => {
      warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      proxy = await startStoreProxy();
    });
    afterEach(async () => {
      warn.mockRestore();
      await proxy.close();
    });

    it('S52 AS-72: a degraded read logs request id, namespace and an 8-hex digest — not the key, its id or the value — and is limited to once per 10 s', async () => {
      const clock = new FakeClock();
      const inst = await createCacheInstance({
        clock,
        clientUrl: proxyUrl(proxy),
        requestId: 'req-abc-123',
      });
      try {
        const ns = uniqueNamespace();
        const id = `customer-${randomUUID()}`;
        const key = keyIn(ns, id);
        proxy.mode = 'refuse';
        proxy.sever();
        await waitFor(async () => inst.redis.client.status !== 'ready');

        await inst.cache.getOrLoad(
          key,
          async () => ({ secret: 'VALUE-MARKER-9f2' }),
          { ttlMs: 60_000 },
        );
        await inst.cache.getOrLoad(
          key,
          async () => ({ secret: 'VALUE-MARKER-9f2' }),
          { ttlMs: 60_000 },
        );

        const lines = warn.mock.calls
          .map((c) => String(c[0]))
          .filter((l) => l.includes(`namespace=${ns}`));
        expect(lines).toHaveLength(1); // second read inside 10 s: rate-limited
        expect(lines[0]).toMatch(/key=[0-9a-f]{8}\b/);
        expect(lines[0]).toContain('requestId=req-abc-123');
        for (const forbidden of [key, id, 'VALUE-MARKER-9f2'])
          expect(lines.join('\n')).not.toContain(forbidden);

        clock.advance(10_001);
        await inst.cache.getOrLoad(key, async () => 'x', { ttlMs: 60_000 });
        expect(
          warn.mock.calls
            .map((c) => String(c[0]))
            .filter((l) => l.includes(`namespace=${ns}`)),
        ).toHaveLength(2);
      } finally {
        await inst.close();
      }
    });

    it('S52 AS-72: an oversize warning is limited to once per 60 s per namespace', async () => {
      const clock = new FakeClock();
      const inst = await createCacheInstance({ clock });
      try {
        const ns = uniqueNamespace();
        const big = async () => 'x'.repeat(300 * 1024);
        const count = () =>
          warn.mock.calls
            .map((c) => String(c[0]))
            .filter((l) => l.includes(`namespace=${ns}`)).length;

        await inst.cache.getOrLoad(keyIn(ns), big, { ttlMs: 60_000 });
        await inst.cache.getOrLoad(keyIn(ns), big, { ttlMs: 60_000 });
        clock.advance(59_000);
        await inst.cache.getOrLoad(keyIn(ns), big, { ttlMs: 60_000 });
        expect(count()).toBe(1);
        clock.advance(1_001);
        await inst.cache.getOrLoad(keyIn(ns), big, { ttlMs: 60_000 });
        expect(count()).toBe(2);
      } finally {
        await inst.close();
      }
    });
  });

  describe('S52 AS-73: shutdown', () => {
    const sockets = () =>
      process.getActiveResourcesInfo().filter((r) => r === 'TCPSocketWrap')
        .length;

    it('S52 AS-73: the shutdown task awaits two running refreshes, closes the subscription and leaves no connection or tracked refresh behind', async () => {
      const clock = new FakeClock();
      const baseline = sockets();
      const registry = new ShutdownRegistry();
      const inst = await createCacheInstance({ clock, shutdown: registry });
      try {
        const options = { ttlMs: 1_000, swrMs: 60_000, jitter: 0 };
        const keys = [keyIn(uniqueNamespace()), keyIn(uniqueNamespace())];
        for (const key of keys)
          await inst.cache.getOrLoad(key, async () => 'old', options);
        clock.advance(1_001);
        const gate = new Deferred();
        const refreshing = jest.fn(async () => {
          await gate.promise;
          return 'new';
        });
        for (const key of keys)
          expect(await inst.cache.getOrLoad(key, refreshing, options)).toBe(
            'old',
          );
        await waitFor(async () => inst.cache.stats().pendingRefreshes === 2);
        expect(registry.listTaskNames()).toContain('cache.toolkit.close');

        const stopped = registry.run('stop');
        setTimeout(() => gate.resolve(), 200);
        const result = await stopped;

        expect(result.failed).toEqual([]);
        expect(refreshing).toHaveBeenCalledTimes(2);
        for (const key of keys)
          expect(JSON.parse((await inst.redis.client.get(key))!).v).toBe('new'); // awaited, not abandoned
        expect(inst.cache.stats()).toMatchObject({
          pendingRefreshes: 0,
          inFlight: 0,
          broadcastHealthy: false,
        });
        // A read made during shutdown is answered from the loader.
        expect(
          await inst.cache.getOrLoad(
            keyIn(uniqueNamespace()),
            async () => 'during',
            { ttlMs: 1_000 },
          ),
        ).toBe('during');
      } finally {
        await inst.close();
      }
      await waitFor(async () => sockets() <= baseline, {
        description: 'connections closed',
      });
    });

    it('S52 AS-73: a refresh that never finishes is abandoned after the wait, without error', async () => {
      const clock = new FakeClock();
      const inst = await createCacheInstance({
        clock,
        config: { refreshShutdownWaitMs: 300 },
      });
      try {
        const options = { ttlMs: 1_000, swrMs: 60_000, jitter: 0 };
        const key = keyIn(uniqueNamespace());
        await inst.cache.getOrLoad(key, async () => 'old', options);
        clock.advance(1_001);
        const never = new Deferred<string>();
        await inst.cache.getOrLoad(key, () => never.promise, options);
        await waitFor(async () => inst.cache.stats().pendingRefreshes === 1);

        const started = Date.now();
        await inst.cache.onModuleDestroy();
        expect(Date.now() - started).toBeGreaterThanOrEqual(280);
        expect(Date.now() - started).toBeLessThan(2_000);
        never.resolve('late');
      } finally {
        await inst.close();
      }
    });

    it('S52 AS-73: Nest app.close() runs the same shutdown', async () => {
      const clock = new FakeClock();
      const baseline = sockets();
      const redis = new RedisService(configFor(testRedisUrl()));
      const moduleRef = await Test.createTestingModule({
        providers: [
          { provide: RedisService, useValue: redis },
          { provide: ApiConfigService, useValue: configFor(testRedisUrl()) },
          { provide: CLOCK, useValue: clock },
          { provide: RANDOM_SOURCE, useValue: ScriptedRandom.constant(0.5) },
          { provide: CACHE_TOOLKIT_CONFIG, useValue: {} },
          CacheService,
        ],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      const cache = app.get(CacheService);
      await waitFor(async () => cache.stats().broadcastHealthy);
      expect(
        await cache.getOrLoad(keyIn(uniqueNamespace()), async () => 'v', {
          ttlMs: 1_000,
        }),
      ).toBe('v');

      await app.close();
      redis.client.disconnect();

      expect(cache.stats().broadcastHealthy).toBe(false);
      await waitFor(async () => sockets() <= baseline, {
        description: 'connections closed',
      });
    });
  });
});
