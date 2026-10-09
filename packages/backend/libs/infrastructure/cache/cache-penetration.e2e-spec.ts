import { randomUUID } from 'node:crypto';
import * as fc from 'fast-check';
import { FakeClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { RedisBloomFilter } from './bloom-filter';
import { CacheUnavailable } from './cache.errors';
import {
  CacheInstance,
  createCacheInstance,
  outcomeCount,
  proxyUrl,
  ScriptedRandom,
  startStoreProxy,
  uniqueNamespace,
} from './testing/cache-fixture.module';

const keyIn = (ns: string, id: string = randomUUID()) => `${ns}:v1:${id}`;

describe('Cache penetration protection', () => {
  const clock = new FakeClock();
  let inst: CacheInstance;

  beforeAll(async () => {
    inst = await createCacheInstance({
      clock,
      random: ScriptedRandom.constant(0.5),
    });
  });

  afterAll(async () => {
    await inst.close();
  });

  it('S52 AS-22: five reads of an unknown key hit the source once; the negative entry lives about 10 s and is reloaded after 12 s', async () => {
    const ns = uniqueNamespace();
    const key = keyIn(ns);
    const loader = jest.fn(async () => null);
    const options = { ttlMs: 60_000, negativeTtlMs: 10_000 };

    for (let i = 0; i < 5; i++)
      expect(await inst.cache.getOrLoad(key, loader, options)).toBeNull();

    expect(loader).toHaveBeenCalledTimes(1);
    expect(outcomeCount(ns, 'negative')).toBe(4);
    const pttl = await inst.redis.client.pttl(key);
    expect(pttl).toBeGreaterThanOrEqual(9_000);
    expect(pttl).toBeLessThanOrEqual(11_000);

    clock.advance(12_000);
    expect(await inst.cache.getOrLoad(key, loader, options)).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('S52 AS-23: a negative entry past its soft expiry is a miss even with swrMs; an item created meanwhile is found', async () => {
    const key = keyIn(uniqueNamespace());
    const options = {
      ttlMs: 60_000,
      negativeTtlMs: 10_000,
      swrMs: 60_000,
      staleIfErrorMs: 300_000,
      jitter: 0,
    };
    await inst.cache.getOrLoad(key, async () => null, options);
    const stored = JSON.parse((await inst.redis.client.get(key))!);
    expect(stored.v).toBeNull();
    expect(stored.hard).toBe(stored.exp); // no stale window for "not found"

    clock.advance(10_001);
    const created = jest.fn(async () => ({ id: 'now-exists' }));
    expect(await inst.cache.getOrLoad(key, created, options)).toEqual({
      id: 'now-exists',
    });
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('S52 AS-23: a failing loader after a negative entry expired raises the error (no stale-if-error for "not found")', async () => {
    const key = keyIn(uniqueNamespace());
    const options = {
      ttlMs: 60_000,
      negativeTtlMs: 10_000,
      staleIfErrorMs: 300_000,
      jitter: 0,
    };
    await inst.cache.getOrLoad(key, async () => null, options);
    clock.advance(10_001);
    await expect(
      inst.cache.getOrLoad(
        key,
        async () => {
          throw new Error('down');
        },
        options,
      ),
    ).rejects.toThrow('down');
  });

  it('S52 AS-24: without negativeTtlMs a null is not stored and the loader runs every time', async () => {
    const key = keyIn(uniqueNamespace());
    const loader = jest.fn(async () => null);
    expect(
      await inst.cache.getOrLoad(key, loader, { ttlMs: 60_000 }),
    ).toBeNull();
    expect(
      await inst.cache.getOrLoad(key, loader, { ttlMs: 60_000 }),
    ).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(await inst.redis.client.exists(key)).toBe(0);
  });

  it('S52 AS-25: invalidate replaces a negative entry so the next read loads the created item', async () => {
    const key = keyIn(uniqueNamespace());
    const options = { ttlMs: 60_000, negativeTtlMs: 10_000 };
    await inst.cache.getOrLoad(key, async () => null, options);
    expect(await inst.redis.client.exists(key)).toBe(1);

    const result = await inst.cache.invalidate([key]);
    expect(result).toEqual({ l2: 'ok', deleted: 1 });

    expect(
      await inst.cache.getOrLoad(key, async () => ({ id: 'created' }), options),
    ).toEqual({
      id: 'created',
    });
  });

  describe('S52 AS-26: Bloom filter on the real store', () => {
    it('S52 AS-26: zero false negatives for any set of strings (property-based)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(fc.string({ minLength: 1, maxLength: 40 }), {
            minLength: 1,
            maxLength: 60,
          }),
          async (items) => {
            const filter = new RedisBloomFilter(
              inst.redis,
              `bloom:prop:${randomUUID()}`,
              1_000,
              0.01,
            );
            await filter.add(items);
            for (const item of items)
              if (!(await filter.mightContain(item))) return false;
            return true;
          },
        ),
        { numRuns: 25 },
      );
    });

    it('S52 AS-26: 10,000 members all answer true and 10,000 never-added items give at most 2 % false positives', async () => {
      const key = `bloom:rate:${randomUUID()}`;
      const filter = new RedisBloomFilter(inst.redis, key, 10_000, 0.01);
      const members = Array.from({ length: 10_000 }, (_, i) => `member-${i}`);
      for (let i = 0; i < members.length; i += 1_000)
        await filter.add(members.slice(i, i + 1_000));

      let missing = 0;
      for (let i = 0; i < members.length; i += 500) {
        const answers = await Promise.all(
          members.slice(i, i + 500).map((m) => filter.mightContain(m)),
        );
        missing += answers.filter((a) => !a).length;
      }
      expect(missing).toBe(0);

      let falsePositives = 0;
      for (let i = 0; i < 10_000; i += 500) {
        const answers = await Promise.all(
          Array.from({ length: 500 }, (_, j) =>
            filter.mightContain(`stranger-${i + j}`),
          ),
        );
        falsePositives += answers.filter(Boolean).length;
      }
      expect(falsePositives / 10_000).toBeLessThanOrEqual(0.02);
      expect(await inst.redis.client.strlen(key)).toBeGreaterThan(0);
      await inst.redis.client.del(key);
    });
  });

  describe('S52 AS-28: Bloom filter with the store down', () => {
    let proxy: TcpFaultProxy;
    let degraded: CacheInstance;

    beforeAll(async () => {
      proxy = await startStoreProxy();
      degraded = await createCacheInstance({ clientUrl: proxyUrl(proxy) });
    });

    afterAll(async () => {
      await degraded.close();
      await proxy.close();
    });

    afterEach(() => {
      proxy.mode = 'pass';
    });

    it('S52 AS-28: mightContain answers true and counts a degraded check; add rejects with CacheUnavailable', async () => {
      const filter = new RedisBloomFilter(
        degraded.redis,
        `bloom:down:${randomUUID()}`,
        1_000,
        0.01,
      );
      await filter.add(['present']);
      expect(await filter.mightContain('absent-item')).toBe(false);

      const before = MetricsRegistry.value('cache_bloom_degraded_total') ?? 0;
      proxy.mode = 'refuse';
      proxy.sever();

      expect(await filter.mightContain('absent-item')).toBe(true);
      expect(MetricsRegistry.value('cache_bloom_degraded_total')).toBe(
        before + 1,
      );
      await expect(filter.add(['x'])).rejects.toBeInstanceOf(CacheUnavailable);
    });

    it('S52 AS-28: adding the same item twice changes nothing', async () => {
      const key = `bloom:idem:${randomUUID()}`;
      const filter = new RedisBloomFilter(inst.redis, key, 1_000, 0.01);
      await filter.add(['same']);
      const once = await inst.redis.client.getrangeBuffer(key, 0, -1);
      await filter.add(['same']);
      const twice = await inst.redis.client.getrangeBuffer(key, 0, -1);
      expect(twice.equals(once)).toBe(true);
      expect(await filter.mightContain('same')).toBe(true);
      await inst.redis.client.del(key);
    });

    it('S52 AS-28: a hanging store is abandoned after the call timeout and answers true', async () => {
      const filter = new RedisBloomFilter(
        degraded.redis,
        `bloom:hang:${randomUUID()}`,
        1_000,
        0.01,
      );
      proxy.mode = 'hang';
      const started = Date.now();
      expect(await filter.mightContain('anything')).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });
});
