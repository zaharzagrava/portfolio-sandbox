import { randomUUID } from 'node:crypto';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import { FakeClock } from '@app/common/core/clock';
import { recomputeLockKey } from './cache-key';
import {
  CacheInstance,
  createCacheInstance,
  Deferred,
  outcomeCount,
  ScriptedRandom,
  uniqueNamespace,
} from './testing/cache-fixture.module';

const keyIn = (ns: string, id: string = randomUUID()) => `${ns}:v1:${id}`;
const later = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe('Cache stampede protection', () => {
  const clock = new FakeClock();
  let a: CacheInstance;
  let b: CacheInstance;
  let c: CacheInstance;

  beforeAll(async () => {
    const random = ScriptedRandom.constant(0.5);
    a = await createCacheInstance({ clock, random });
    b = await createCacheInstance({ clock, random });
    c = await createCacheInstance({ clock, random });
  });

  afterAll(async () => {
    await Promise.all([a.close(), b.close(), c.close()]);
  });

  it('S52 AS-12: 200 concurrent misses on one instance call the loader once', async () => {
    const key = keyIn(uniqueNamespace());
    const loader = jest.fn(() => later(100, { value: 42 }));

    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        a.cache.getOrLoad(key, loader, { ttlMs: 60_000 }),
      ),
    );

    expect(loader).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(200);
    expect(results.every((r) => r?.value === 42)).toBe(true);
    expect(a.cache.stats().inFlight).toBe(0);
  });

  it('S52 AS-13: three instances with 100 reads each load a cold key once; followers read the leader’s stored value', async () => {
    const ns = uniqueNamespace();
    const key = keyIn(ns);
    const loader = jest.fn(() => later(150, 'leader-value'));

    const results = await Promise.all(
      [a, b, c].flatMap((inst) =>
        Array.from({ length: 100 }, () =>
          inst.cache.getOrLoad(key, loader, { ttlMs: 60_000 }),
        ),
      ),
    );

    expect(loader).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(300);
    expect(results.every((r) => r === 'leader-value')).toBe(true);
    expect(JSON.parse((await a.redis.client.get(key))!).v).toBe('leader-value');
    expect(await a.redis.client.exists(recomputeLockKey(key))).toBe(0);
    // two followers answered from the leader's entry (counted as L2 reads)
    expect(outcomeCount(ns, 'l2')).toBeGreaterThanOrEqual(2);
  });

  describe('S52 AS-14: the recompute lock is owned', () => {
    it('S52 AS-14: a holder that outlives its lock cannot delete the next holder’s lock', async () => {
      const key = keyIn(uniqueNamespace());
      const lockKey = recomputeLockKey(key);
      const gateA = new Deferred();
      const gateB = new Deferred();
      const loaderA = jest.fn(async () => {
        await gateA.promise;
        return 'from-a';
      });
      const loaderB = jest.fn(async () => {
        await gateB.promise;
        return 'from-b';
      });

      const readA = a.cache.getOrLoad(key, loaderA, { ttlMs: 60_000 });
      await waitFor(async () => (await a.redis.client.get(lockKey)) !== null, {
        description: 'A holds the lock',
      });
      const tokenA = (await a.redis.client.get(lockKey))!;
      expect(tokenA).not.toBe('1'); // an owner token, not a flag

      await a.redis.client.del(lockKey); // A's lock lifetime ends while its loader still runs
      const readB = b.cache.getOrLoad(key, loaderB, { ttlMs: 60_000 });
      await waitFor(async () => (await b.redis.client.get(lockKey)) !== null, {
        description: 'B holds a new lock',
      });
      const tokenB = (await b.redis.client.get(lockKey))!;
      expect(tokenB).not.toBe(tokenA);

      gateA.resolve();
      expect(await readA).toBe('from-a');
      expect(await a.redis.client.get(lockKey)).toBe(tokenB); // A's release did not touch B's lock

      gateB.resolve();
      expect(await readB).toBe('from-b');
      expect(await a.redis.client.exists(lockKey)).toBe(0); // B released its own
    });

    it('S52 AS-14: a follower whose lock holder died stops waiting after 500 ms and loads itself', async () => {
      const key = keyIn(uniqueNamespace());
      const lockKey = recomputeLockKey(key);
      await a.redis.client.set(lockKey, 'dead-holder', 'PX', 60_000);
      const get = jest.spyOn(b.redis.client, 'get');
      const loader = jest.fn(async () => 'self-loaded');

      const read = b.cache.getOrLoad(key, loader, { ttlMs: 60_000 });
      await waitFor(async () => get.mock.calls.length >= 2, {
        description: 'the follower is polling',
      });
      expect(loader).not.toHaveBeenCalled();
      clock.advance(501);

      expect(await read).toBe('self-loaded');
      expect(loader).toHaveBeenCalledTimes(1);
      expect(await a.redis.client.get(lockKey)).toBe('dead-holder'); // not ours: left alone
      get.mockRestore();
    });
  });

  it('S52 AS-15: a rejecting loader rejects all 50 waiters with the same error, caches nothing and frees the lock', async () => {
    const key = keyIn(uniqueNamespace());
    const failure = new Error('source down');
    const loader = jest.fn(async () => {
      await later(50, undefined);
      throw failure;
    });

    const settled = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        a.cache.getOrLoad(key, loader, { ttlMs: 60_000 }),
      ),
    );

    expect(
      settled.every((r) => r.status === 'rejected' && r.reason === failure),
    ).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await a.redis.client.exists(key)).toBe(0);
    expect(await a.redis.client.exists(recomputeLockKey(key))).toBe(0);
    expect(a.cache.stats().inFlight).toBe(0);

    await expect(
      a.cache.getOrLoad(key, loader, { ttlMs: 60_000 }),
    ).rejects.toBe(failure);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  describe('S52 AS-16/AS-17: stale-while-revalidate', () => {
    const options = { ttlMs: 200, swrMs: 60_000, jitter: 0 };

    it('S52 AS-16: fresh at exp−1, stale at exp with exactly one refresh across three instances', async () => {
      const ns = uniqueNamespace();
      const key = keyIn(ns);
      const stored = await a.cache.getOrLoad(key, async () => 'v1', options);
      expect(stored).toBe('v1');
      const exp = JSON.parse((await a.redis.client.get(key))!).exp as number;

      clock.set(new Date(exp - 1));
      const fresh = jest.fn(async () => 'v2');
      expect(await b.cache.getOrLoad(key, fresh, options)).toBe('v1');
      expect(outcomeCount(ns, 'l2')).toBe(1);
      expect(fresh).not.toHaveBeenCalled();

      clock.set(new Date(exp));
      const refresh = jest.fn(() => later(50, 'v2'));
      const served = await Promise.all(
        [a, b, c].flatMap((inst) =>
          Array.from({ length: 100 }, () =>
            inst.cache.getOrLoad(key, refresh, options),
          ),
        ),
      );
      expect(served.every((v) => v === 'v1')).toBe(true); // stale answered at once
      expect(outcomeCount(ns, 'stale')).toBeGreaterThanOrEqual(1);

      await waitFor(
        async () =>
          JSON.parse((await a.redis.client.get(key))!).v === 'v2' &&
          [a, b, c].every((i) => i.cache.stats().pendingRefreshes === 0),
        { description: 'the refresh finished' },
      );
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(await c.cache.getOrLoad(key, refresh, options)).toBe('v2');
    });

    it('S52 AS-16: a failing refresh never reaches the reader; the stale value is kept and the failure counted', async () => {
      const ns = uniqueNamespace();
      const key = keyIn(ns);
      await a.cache.getOrLoad(key, async () => 'v1', options);
      const exp = JSON.parse((await a.redis.client.get(key))!).exp as number;
      clock.set(new Date(exp + 10));
      const failing = jest.fn(async () => {
        throw new Error('refresh broke');
      });

      expect(await b.cache.getOrLoad(key, failing, options)).toBe('v1');
      await waitFor(async () => outcomeCount(ns, 'refresh_failed') === 1, {
        description: 'refresh_failed counted',
      });
      await waitFor(async () => b.cache.stats().pendingRefreshes === 0);
      expect(await a.redis.client.exists(recomputeLockKey(key))).toBe(0);
      expect(await b.cache.getOrLoad(key, failing, options)).toBe('v1');
    });

    it('S52 AS-17: at exp + swrMs the entry is gone and the read loads synchronously', async () => {
      const ns = uniqueNamespace();
      const key = keyIn(ns);
      await a.cache.getOrLoad(key, async () => 'v1', options);
      const { exp, hard } = JSON.parse((await a.redis.client.get(key))!);
      expect(hard).toBe(exp + 60_000);
      clock.set(new Date(exp + 60_000));
      const loader = jest.fn(async () => 'v2');

      expect(await b.cache.getOrLoad(key, loader, options)).toBe('v2');
      expect(loader).toHaveBeenCalledTimes(1);
      expect(outcomeCount(ns, 'miss')).toBe(2); // the first load and this one
    });
  });

  describe('S52 AS-18: stale-if-error', () => {
    const options = {
      ttlMs: 1_000,
      swrMs: 1_000,
      staleIfErrorMs: 300_000,
      jitter: 0,
    };

    it('S52 AS-18: a failing loader inside the window serves the stale value; beyond it the error propagates', async () => {
      const ns = uniqueNamespace();
      const key = keyIn(ns);
      await a.cache.getOrLoad(key, async () => 'v1', options);
      const exp = JSON.parse((await a.redis.client.get(key))!).exp as number;
      const broken = jest.fn(async () => {
        throw new Error('source down');
      });

      clock.set(new Date(exp + 1_000 + 1)); // past exp + swrMs, inside exp + staleIfErrorMs
      expect(await b.cache.getOrLoad(key, broken, options)).toBe('v1');
      expect(outcomeCount(ns, 'stale_error')).toBe(1);
      expect(broken).toHaveBeenCalledTimes(1);

      clock.set(new Date(exp + 300_001)); // past the stale-if-error window
      await expect(b.cache.getOrLoad(key, broken, options)).rejects.toThrow(
        'source down',
      );
    });
  });

  it('S52 AS-21: the loader is timed on the injected clock, stored as delta and recorded in the histogram', async () => {
    const ns = uniqueNamespace();
    const key = keyIn(ns);
    await a.cache.getOrLoad(
      key,
      async () => {
        clock.advance(120);
        return 'v';
      },
      { ttlMs: 60_000 },
    );

    expect(JSON.parse((await a.redis.client.get(key))!).delta).toBe(120);
    const histogram = MetricsRegistry.histogramValue(
      'cache_loader_duration_seconds',
      {
        namespace: ns,
      },
    );
    expect(histogram?.count).toBe(1);
    expect(histogram?.sum).toBeCloseTo(0.12, 5);
    expect(
      MetricsRegistry.value('cache_loader_calls_total', { namespace: ns }),
    ).toBe(1);
  });
});
