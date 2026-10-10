import { Logger } from '@nestjs/common';
import { waitFor } from '@app/test/utils/async-helpers';
import { CacheService } from './cache.service';
import { InvalidCacheOptions, InvalidLoaderResult } from './cache.errors';
import {
  CacheInstance,
  countStoreCalls,
  createCacheInstance,
  Deferred,
  outcomeCount,
  proxyUrl,
  ScriptedRandom,
  startStoreProxy,
  uniqueNamespace,
} from './testing/cache-fixture.module';
import { randomUUID } from 'node:crypto';

const keyIn = (ns: string, id: string = randomUUID()) => `${ns}:v1:${id}`;

describe('Cache read path (L1 → L2 → loader)', () => {
  let inst: CacheInstance;
  let cache: CacheService;

  beforeAll(async () => {
    inst = await createCacheInstance({ random: ScriptedRandom.constant(0.5) });
    cache = inst.cache;
  });

  afterAll(async () => {
    await inst.close();
  });

  it('S52 AS-01: cold read loads once, warm read is served from the store with a jittered lifetime', async () => {
    const ns = uniqueNamespace();
    const key = keyIn(ns);
    const loader = jest.fn(async () => ({ n: 1 }));

    const first = await cache.getOrLoad(key, loader, { ttlMs: 60_000 });
    const second = await cache.getOrLoad(key, loader, { ttlMs: 60_000 });

    expect(first).toEqual({ n: 1 });
    expect(second).toEqual({ n: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    const pttl = await inst.redis.client.pttl(key);
    expect(pttl).toBeGreaterThanOrEqual(54_000);
    expect(pttl).toBeLessThanOrEqual(66_000);
    const stored = JSON.parse((await inst.redis.client.get(key))!);
    expect(stored.v).toEqual({ n: 1 });
    expect(stored.exp - inst.clock.nowMs()).toBeGreaterThanOrEqual(54_000);
    expect(stored.exp - inst.clock.nowMs()).toBeLessThanOrEqual(66_000);
    expect(outcomeCount(ns, 'miss')).toBe(1);
    expect(outcomeCount(ns, 'l2')).toBe(1);
  });

  it('S52 AS-02: l1 always serves from memory with zero store calls until l1TtlMs, then refills from the store', async () => {
    const ns = uniqueNamespace();
    const key = keyIn(ns);
    const loader = jest.fn(async () => 'v');
    const options = { ttlMs: 60_000, l1: 'always' as const, l1TtlMs: 1_000 };
    await cache.getOrLoad(key, loader, options);

    const calls = await countStoreCalls(inst.redis, () =>
      cache.getOrLoad(key, loader, options),
    );
    expect(calls).toBe(0);
    expect(outcomeCount(ns, 'l1')).toBe(1);

    inst.clock.advance(1_001);
    const l2Before = outcomeCount(ns, 'l2');
    await cache.getOrLoad(key, loader, options);
    expect(outcomeCount(ns, 'l2')).toBe(l2Before + 1);

    const refilled = await countStoreCalls(inst.redis, () =>
      cache.getOrLoad(key, loader, options),
    );
    expect(refilled).toBe(0);
    expect(cache.l1Has(key)).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('S52 AS-03: l1 never keeps no per-process copy and every read after the first is an L2 hit', async () => {
    const ns = uniqueNamespace();
    const key = keyIn(ns);
    const before = cache.stats().l1Entries;
    const loader = jest.fn(async () => 'v');
    for (let i = 0; i < 1_000; i++) {
      await cache.getOrLoad(key, loader, { ttlMs: 60_000, l1: 'never' });
      if (i % 100 === 0) expect(cache.l1Has(key)).toBe(false);
    }
    expect(cache.l1Has(key)).toBe(false);
    expect(cache.stats().l1Entries).toBe(before);
    expect(outcomeCount(ns, 'miss')).toBe(1);
    expect(outcomeCount(ns, 'l2')).toBe(999);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('S52 AS-04: a key the sampler sees 25 times in a window is promoted to L1 in the next window, then demoted', async () => {
    const hot = await createCacheInstance({
      random: ScriptedRandom.constant(0),
    });
    try {
      const ns = uniqueNamespace();
      const h = keyIn(ns, 'hot');
      const c = keyIn(ns, 'cold');
      const loader = jest.fn(async () => 'v');
      const options = { ttlMs: 600_000, l1TtlMs: 1_000 };
      for (let i = 0; i < 25; i++)
        await hot.cache.getOrLoad(h, loader, options);
      await hot.cache.getOrLoad(c, loader, options);
      expect(hot.cache.l1Has(h)).toBe(false);

      hot.clock.advance(10_000);
      await hot.cache.getOrLoad(h, loader, options); // fills L1: now promoted
      await hot.cache.getOrLoad(c, loader, options);
      expect(hot.cache.l1Has(h)).toBe(true);
      expect(hot.cache.l1Has(c)).toBe(false);
      const calls = await countStoreCalls(hot.redis, () =>
        hot.cache.getOrLoad(h, loader, options),
      );
      expect(calls).toBe(0);
      expect(outcomeCount(ns, 'l1')).toBe(1);

      // A window in which H is read fewer than 20 times: no longer promoted.
      hot.clock.advance(10_000);
      hot.clock.advance(1_001);
      await hot.cache.getOrLoad(h, loader, options);
      expect(hot.cache.l1Has(h)).toBe(false);
    } finally {
      await hot.close();
    }
  });

  it('S52 AS-05: L1 never exceeds 10,000 entries or 64 MiB over 20,000 distinct keys, and evicted keys still read from the store', async () => {
    const big = await createCacheInstance({
      random: ScriptedRandom.constant(0.5),
    });
    try {
      const ns = uniqueNamespace();
      const keys = Array.from({ length: 20_000 }, (_, i) => keyIn(ns, `k${i}`));
      const loader = (i: number) => jest.fn(async () => ({ i }));
      const loaders = keys.map((_, i) => loader(i));
      for (let start = 0; start < keys.length; start += 2_000) {
        await Promise.all(
          keys.slice(start, start + 2_000).map((key, j) =>
            big.cache.getOrLoad(key, loaders[start + j], {
              ttlMs: 600_000,
              l1: 'always',
            }),
          ),
        );
        const { l1Entries, l1Bytes } = big.cache.stats();
        expect(l1Entries).toBeLessThanOrEqual(10_000);
        expect(l1Bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      }
      expect(big.cache.stats().l1Entries).toBe(10_000);
      expect(big.cache.l1Has(keys[0])).toBe(false); // least recently used dropped
      expect(big.cache.l1Has(keys[19_999])).toBe(true);
      const value = await big.cache.getOrLoad(keys[0], loaders[0], {
        ttlMs: 600_000,
        l1: 'always',
      });
      expect(value).toEqual({ i: 0 });
      expect(loaders[0]).toHaveBeenCalledTimes(1); // served from the store, not reloaded
    } finally {
      await big.close();
    }
  }, 120_000);

  it.each([
    ['undefined', async () => undefined],
    [
      'a cyclic object',
      async () => {
        const a: Record<string, unknown> = {};
        a.self = a;
        return a;
      },
    ],
    ['a BigInt', async () => BigInt(5)],
  ])(
    'S52 AS-06: a loader resolving %s rejects with InvalidLoaderResult and stores nothing',
    async (_name, impl) => {
      const key = keyIn(uniqueNamespace());
      const loader = jest.fn(impl as () => Promise<never>);
      await expect(
        cache.getOrLoad(key, loader, { ttlMs: 60_000 }),
      ).rejects.toBeInstanceOf(InvalidLoaderResult);
      expect(await inst.redis.client.exists(key)).toBe(0);
      await expect(
        cache.getOrLoad(key, loader, { ttlMs: 60_000 }),
      ).rejects.toBeInstanceOf(InvalidLoaderResult);
      expect(loader).toHaveBeenCalledTimes(2); // the failure was not cached
    },
  );

  it('S52 AS-07: unparseable bytes in the store are a miss, are overwritten, and the next read is an L2 hit', async () => {
    const ns = uniqueNamespace();
    const key = keyIn(ns);
    await inst.redis.client.set(key, '\u0000\u0001 not an envelope');
    const loader = jest.fn(async () => ({ ok: true }));

    expect(await cache.getOrLoad(key, loader, { ttlMs: 60_000 })).toEqual({
      ok: true,
    });
    expect(outcomeCount(ns, 'corrupt')).toBe(1);
    expect(JSON.parse((await inst.redis.client.get(key))!).v).toEqual({
      ok: true,
    });

    expect(await cache.getOrLoad(key, loader, { ttlMs: 60_000 })).toEqual({
      ok: true,
    });
    expect(outcomeCount(ns, 'l2')).toBe(1);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  describe('S52 AS-08: big entries are returned but not stored', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    it('S52 AS-08: a 300 KiB value is returned twice, stored nowhere, counted twice and logged once without the value', async () => {
      const ns = uniqueNamespace();
      const key = keyIn(ns);
      const value = { blob: 'SECRETMARKER'.repeat(25_600) }; // ~300 KiB
      const loader = jest.fn(async () => value);
      const options = { ttlMs: 60_000, l1: 'always' as const };

      expect(await cache.getOrLoad(key, loader, options)).toEqual(value);
      expect(await cache.getOrLoad(key, loader, options)).toEqual(value);

      expect(await inst.redis.client.exists(key)).toBe(0);
      expect(cache.l1Has(key)).toBe(false);
      expect(outcomeCount(ns, 'oversize')).toBe(2);
      expect(loader).toHaveBeenCalledTimes(2);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes(ns))).toHaveLength(1);
      expect(lines.join('\n')).not.toContain('SECRETMARKER');
    });

    it('S52 AS-08: concurrent oversize reads still share one load', async () => {
      const key = keyIn(uniqueNamespace());
      const gate = new Deferred();
      const loader = jest.fn(async () => {
        await gate.promise;
        return 'x'.repeat(300 * 1024);
      });
      const reads = Array.from({ length: 5 }, () =>
        cache.getOrLoad(key, loader, { ttlMs: 60_000 }),
      );
      await waitFor(async () => loader.mock.calls.length > 0, {
        description: 'loader started',
      });
      gate.resolve();
      await Promise.all(reads);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('S52 AS-08: maxEntryBytes lowers or raises the cap up to 1 MiB', async () => {
      const small = keyIn(uniqueNamespace());
      await cache.getOrLoad(small, async () => 'y'.repeat(2_048), {
        ttlMs: 60_000,
        maxEntryBytes: 1_024,
      });
      expect(await inst.redis.client.exists(small)).toBe(0);

      const raised = keyIn(uniqueNamespace());
      await cache.getOrLoad(raised, async () => 'y'.repeat(300 * 1024), {
        ttlMs: 60_000,
        maxEntryBytes: 1024 * 1024,
      });
      expect(await inst.redis.client.exists(raised)).toBe(1);
    });
  });

  describe('S52 AS-11: getOrLoadMany', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${i}`);

    it('S52 AS-11: 100 keys with 40 cached read the store once, call the batch loader once with the 60 missing keys in order, and write in one round trip', async () => {
      const ns = uniqueNamespace();
      const keys = ids(100).map((id) => keyIn(ns, id));
      for (const key of keys.slice(0, 40))
        await cache.getOrLoad(key, async () => ({ key }), { ttlMs: 60_000 });
      const missing = keys.slice(40);
      const batchLoader = jest.fn(async (requested: string[]) => {
        const map = new Map<string, { key: string } | null>();
        for (const key of requested) map.set(key, { key });
        return map;
      });
      const proxy = await startStoreProxy();
      const viaProxy = await createCacheInstance({
        clientUrl: proxyUrl(proxy),
        random: ScriptedRandom.constant(0.5),
      });
      try {
        // Warm the proxied connection so its handshake is not counted.
        await viaProxy.redis.client.ping();
        const mget = jest.spyOn(viaProxy.redis.client, 'mget');
        const chunksBefore = proxy.clientChunks;

        const result = await viaProxy.cache.getOrLoadMany(keys, batchLoader, {
          ttlMs: 60_000,
        });

        expect(mget).toHaveBeenCalledTimes(1);
        expect(batchLoader).toHaveBeenCalledTimes(1);
        expect(batchLoader.mock.calls[0][0]).toEqual(missing);
        expect(result).toEqual(keys.map((key) => ({ key })));
        // One round trip to read everything, one to write the 60 entries (not 1 + 60).
        expect(proxy.clientChunks - chunksBefore).toBeLessThanOrEqual(3);
        for (const key of missing)
          expect(await inst.redis.client.exists(key)).toBe(1);
      } finally {
        await viaProxy.close();
        await proxy.close();
      }
    });

    it('S52 AS-11: a key the batch loader omits or maps to null is null, and negatively cached with negativeTtlMs', async () => {
      const ns = uniqueNamespace();
      const [a, b, c] = ['a', 'b', 'c'].map((id) => keyIn(ns, id));
      const batchLoader = jest.fn(
        async () =>
          new Map([
            [a, 'va'],
            [b, null],
          ]) as Map<string, string | null>,
      );
      const options = { ttlMs: 60_000, negativeTtlMs: 10_000 };

      expect(
        await cache.getOrLoadMany([a, b, c], batchLoader, options),
      ).toEqual(['va', null, null]);

      const loader = jest.fn(async () => 'should not run');
      expect(await cache.getOrLoad(b, loader, options)).toBeNull();
      expect(await cache.getOrLoad(c, loader, options)).toBeNull();
      expect(loader).not.toHaveBeenCalled();
      expect(outcomeCount(ns, 'negative')).toBe(2);
    });

    it('S52 AS-11: a repeated key appears twice in the result and is loaded once', async () => {
      const ns = uniqueNamespace();
      const [a, b] = ['a', 'b'].map((id) => keyIn(ns, id));
      const batchLoader = jest.fn(
        async (requested: string[]) =>
          new Map(requested.map((k) => [k, `v:${k}`])),
      );
      const result = await cache.getOrLoadMany([a, b, a], batchLoader, {
        ttlMs: 60_000,
      });
      expect(result).toEqual([`v:${a}`, `v:${b}`, `v:${a}`]);
      expect(batchLoader.mock.calls[0][0]).toEqual([a, b]);
    });

    it('S52 AS-11: more than 500 keys is rejected before any store call', async () => {
      const ns = uniqueNamespace();
      const keys = ids(501).map((id) => keyIn(ns, id));
      const batchLoader = jest.fn(async () => new Map<string, string | null>());
      await expect(
        cache.getOrLoadMany(keys, batchLoader, { ttlMs: 60_000 }),
      ).rejects.toBeInstanceOf(InvalidCacheOptions);
      expect(batchLoader).not.toHaveBeenCalled();
    });

    it('S52 AS-11: a concurrent getOrLoad for a missing key shares the batch load', async () => {
      const ns = uniqueNamespace();
      const [a, b] = ['a', 'b'].map((id) => keyIn(ns, id));
      const gate = new Deferred();
      const batchLoader = jest.fn(async (requested: string[]) => {
        await gate.promise;
        return new Map(requested.map((k) => [k, `batch:${k}`]));
      });
      const single = jest.fn(async () => 'single');

      const many = cache.getOrLoadMany([a, b], batchLoader, { ttlMs: 60_000 });
      await waitFor(async () => batchLoader.mock.calls.length > 0, {
        description: 'batch loader started',
      });
      const one = cache.getOrLoad(a, single, { ttlMs: 60_000 });
      gate.resolve();

      expect(await many).toEqual([`batch:${a}`, `batch:${b}`]);
      expect(await one).toBe(`batch:${a}`);
      expect(single).not.toHaveBeenCalled();
    });
  });
});
