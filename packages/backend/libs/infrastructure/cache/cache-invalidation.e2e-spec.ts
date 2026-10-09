import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import * as fc from 'fast-check';
import { FakeClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import { InvalidCacheKey, InvalidCacheOptions } from './cache.errors';
import {
  CacheInstance,
  commandCalls,
  countStoreCalls,
  createCacheInstance,
  Deferred,
  outcomeCount,
  proxyUrl,
  readMinimum,
  ScriptedRandom,
  startStoreProxy,
  uniqueNamespace,
} from './testing/cache-fixture.module';

const keyIn = (ns: string, id: string = randomUUID()) => `${ns}:v1:${id}`;
const invalidations = (result: string) =>
  MetricsRegistry.value('cache_invalidations_total', { result }) ?? 0;

interface Doc {
  version: number;
  label?: string;
}
const versioned = {
  ttlMs: 600_000,
  jitter: 0,
  versionOf: (d: Doc) => d.version,
};

describe('Cache invalidation and versioned invalidation', () => {
  const clock = new FakeClock();
  const random = ScriptedRandom.constant(0.5);
  let a: CacheInstance;
  let b: CacheInstance;

  beforeAll(async () => {
    a = await createCacheInstance({ clock, random });
    b = await createCacheInstance({ clock, random });
  });

  afterAll(async () => {
    await Promise.all([a.close(), b.close()]);
  });

  it('S52 AS-29: invalidate deletes with UNLINK, resolves {ok, deleted} and the other instance drops its L1 copy within 1 s', async () => {
    const key = keyIn(uniqueNamespace());
    const always = { ttlMs: 600_000, l1: 'always' as const, l1TtlMs: 5_000 };
    expect(await b.cache.getOrLoad(key, async () => 'old', always)).toBe('old');
    expect(b.cache.l1Has(key)).toBe(true);
    const unlinkBefore = await commandCalls(a.redis, 'unlink');
    const delBefore = await commandCalls(a.redis, 'del');

    expect(await a.cache.invalidate([key])).toEqual({ l2: 'ok', deleted: 1 });

    expect(await a.redis.client.exists(key)).toBe(0);
    expect(await commandCalls(a.redis, 'unlink')).toBe(unlinkBefore + 1);
    expect(await commandCalls(a.redis, 'del')).toBe(delBefore);
    await waitFor(async () => !b.cache.l1Has(key), {
      timeoutMs: 1_000,
      description: 'B dropped L1',
    });
    expect(await b.cache.getOrLoad(key, async () => 'new', always)).toBe('new');
  });

  describe('S52 AS-30: invalidate never throws on store failure', () => {
    let proxy: TcpFaultProxy;
    let broken: CacheInstance;

    beforeAll(async () => {
      proxy = await startStoreProxy();
      broken = await createCacheInstance({
        clock,
        random,
        clientUrl: proxyUrl(proxy),
      });
    });
    afterAll(async () => {
      await broken.close();
      await proxy.close();
    });

    it('S52 AS-30: resolves {failed, 0} within the timeout, evicts the local L1 copy, counts and logs the failure', async () => {
      const ns = uniqueNamespace();
      const key = keyIn(ns);
      const always = { ttlMs: 600_000, l1: 'always' as const, l1TtlMs: 5_000 };
      await broken.cache.getOrLoad(key, async () => 'v', always);
      expect(broken.cache.l1Has(key)).toBe(true);
      const failedBefore = invalidations('failed');
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      proxy.mode = 'refuse';
      proxy.sever();
      const started = Date.now();
      const result = await broken.cache.invalidate([key]);
      proxy.mode = 'pass';

      expect(result).toEqual({ l2: 'failed', deleted: 0 });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(broken.cache.l1Has(key)).toBe(false);
      expect(invalidations('failed')).toBe(failedBefore + 1);
      expect(
        warn.mock.calls
          .map((c) => String(c[0]))
          .some((l) => l.includes(`namespace=${ns}`)),
      ).toBe(true);
      warn.mockRestore();
    });
  });

  describe('S52 AS-31: a missed broadcast is survivable', () => {
    it('S52 AS-31: with its subscription down B bypasses L1, and clears its L1 once the subscription is restored', async () => {
      const proxy = await startStoreProxy();
      const sub = await createCacheInstance({
        clock,
        random,
        subscriberUrl: proxyUrl(proxy),
      });
      try {
        const key = keyIn(uniqueNamespace());
        const always = {
          ttlMs: 600_000,
          l1: 'always' as const,
          l1TtlMs: 5_000,
        };
        expect(await sub.cache.getOrLoad(key, async () => 'old', always)).toBe(
          'old',
        );
        expect(sub.cache.l1Has(key)).toBe(true);

        proxy.mode = 'refuse';
        proxy.sever();
        await waitFor(async () => !sub.cache.stats().broadcastHealthy, {
          description: 'subscription noticed as lost',
        });

        await a.cache.invalidate([key]); // the message never reaches `sub`
        expect(await sub.cache.getOrLoad(key, async () => 'new', always)).toBe(
          'new',
        );
        expect(sub.cache.l1Has(key)).toBe(true); // stale copy still in memory, but...

        const unlinkCalls = await countStoreCalls(sub.redis, () =>
          sub.cache.getOrLoad(key, async () => 'new', always),
        );
        expect(unlinkCalls).toBeGreaterThan(0); // ...it is bypassed: the read went to the store

        proxy.mode = 'pass';
        await waitFor(async () => sub.cache.stats().broadcastHealthy, {
          timeoutMs: 15_000,
          description: 'subscription restored',
        });
        expect(sub.cache.stats().l1Entries).toBe(0); // cleared before use
        expect(
          await sub.cache.getOrLoad(key, async () => 'newer', always),
        ).toBe('new');
      } finally {
        await sub.close();
        await proxy.close();
      }
    });
  });

  describe('S52 AS-32: batches', () => {
    it('S52 AS-32: 5,000 keys with duplicates are deduplicated and deleted in at most 10 store commands', async () => {
      const ns = uniqueNamespace();
      const unique = Array.from({ length: 4_500 }, (_, i) =>
        keyIn(ns, `k${i}`),
      );
      const pipeline = a.redis.client.pipeline();
      for (const key of unique) pipeline.set(key, '{}');
      await pipeline.exec();
      const keys = [...unique, ...unique.slice(0, 500)]; // 5,000 with 500 duplicates

      let result: { l2: string; deleted: number } | undefined;
      const calls = await countStoreCalls(a.redis, async () => {
        result = await a.cache.invalidate(keys);
      });

      expect(result).toEqual({ l2: 'ok', deleted: 4_500 });
      expect(calls).toBeLessThanOrEqual(10);
      expect(await a.redis.client.exists(...unique.slice(0, 100))).toBe(0);
    });

    it('S52 AS-32: an empty array is a no-op that makes no store call', async () => {
      let result: unknown;
      const calls = await countStoreCalls(a.redis, async () => {
        result = await a.cache.invalidate([]);
      });
      expect(calls).toBe(0);
      expect(result).toEqual({ l2: 'ok', deleted: 0 });
    });

    it('S52 AS-09: an invalid key anywhere in the call rejects it before any key is touched', async () => {
      const good = keyIn(uniqueNamespace());
      await a.redis.client.set(good, '{}');
      await expect(
        a.cache.invalidate([good, 'no namespace']),
      ).rejects.toBeInstanceOf(InvalidCacheKey);
      expect(await a.redis.client.exists(good)).toBe(1);
      await a.redis.client.del(good);
    });

    it('S52 AS-32: more than 5,000 keys is rejected', async () => {
      const ns = uniqueNamespace();
      const keys = Array.from({ length: 5_001 }, (_, i) => keyIn(ns, `k${i}`));
      await expect(a.cache.invalidate(keys)).rejects.toBeInstanceOf(
        InvalidCacheOptions,
      );
    });
  });

  describe('S52 AS-33..AS-39: versioned invalidation', () => {
    it('S52 AS-33: invalidateIfOlder(K, 4) over a version-3 entry applies, deletes the entry, records minimum 4 and drops other instances’ L1', async () => {
      const key = keyIn(uniqueNamespace());
      const always = { ...versioned, l1: 'always' as const, l1TtlMs: 5_000 };
      await b.cache.getOrLoad(key, async () => ({ version: 3 }), always);
      expect(b.cache.l1Has(key)).toBe(true);

      expect(await a.cache.invalidateIfOlder(key, 4)).toEqual({
        outcome: 'applied',
      });

      expect(await a.redis.client.exists(key)).toBe(0);
      expect((await readMinimum(a.redis, key))?.version).toBe(4);
      await waitFor(async () => !b.cache.l1Has(key), {
        timeoutMs: 1_000,
        description: 'B dropped L1',
      });
    });

    it('S52 AS-34: a duplicate delivery after a version-4 entry was stored is skipped and keeps the entry', async () => {
      const ns = uniqueNamespace();
      const key = keyIn(ns);
      await a.cache.getOrLoad(key, async () => ({ version: 3 }), versioned);
      await a.cache.invalidateIfOlder(key, 4);
      await a.cache.getOrLoad(key, async () => ({ version: 4 }), versioned);
      const missBefore = outcomeCount(ns, 'miss');

      expect(await a.cache.invalidateIfOlder(key, 4)).toEqual({
        outcome: 'skipped',
      });

      expect(await a.redis.client.exists(key)).toBe(1);
      const loader = jest.fn(async () => ({ version: 9 }));
      expect(await a.cache.getOrLoad(key, loader, versioned)).toEqual({
        version: 4,
      });
      expect(loader).not.toHaveBeenCalled();
      expect(outcomeCount(ns, 'miss')).toBe(missBefore);
    });

    it('S52 AS-35: a late invalidateIfOlder(K, 4) over version 5 (or over a recorded minimum 5) is skipped and lowers nothing', async () => {
      const key = keyIn(uniqueNamespace());
      await a.cache.getOrLoad(key, async () => ({ version: 5 }), versioned);
      expect(await a.cache.invalidateIfOlder(key, 4)).toEqual({
        outcome: 'skipped',
      });
      expect(await a.redis.client.exists(key)).toBe(1);
      expect(await readMinimum(a.redis, key)).toBeNull();

      const other = keyIn(uniqueNamespace());
      expect(await a.cache.invalidateIfOlder(other, 5)).toEqual({
        outcome: 'applied',
      });
      const before = await readMinimum(a.redis, other);
      expect(await a.cache.invalidateIfOlder(other, 4)).toEqual({
        outcome: 'skipped',
      });
      expect(await readMinimum(a.redis, other)).toEqual(before);
      expect(before?.version).toBe(5);
    });

    it('S52 AS-36: a slow reader that loaded version 3 cannot resurrect it; versions 4, 5 and above are accepted', async () => {
      const ns = uniqueNamespace();
      const key = keyIn(ns);
      const gate = new Deferred();
      const slow = jest.fn(async () => {
        await gate.promise;
        return { version: 3 };
      });
      const reader = a.cache.getOrLoad(key, slow, versioned);
      await waitFor(async () => slow.mock.calls.length > 0, {
        description: 'slow loader started',
      });

      expect(await b.cache.invalidateIfOlder(key, 4)).toEqual({
        outcome: 'applied',
      });
      gate.resolve();

      expect(await reader).toEqual({ version: 3 }); // its caller still gets what it loaded
      expect(await a.redis.client.exists(key)).toBe(0);
      expect(outcomeCount(ns, 'refused_below_minimum')).toBe(1);

      expect(
        await a.cache.getOrLoad(key, async () => ({ version: 4 }), versioned),
      ).toEqual({ version: 4 });
      expect(await a.redis.client.exists(key)).toBe(1);
      await a.cache.invalidate([key]);
      await a.cache.getOrLoad(key, async () => ({ version: 5 }), versioned);
      expect(JSON.parse((await a.redis.client.get(key))!).ver).toBe(5);
    });

    it('S52 AS-37: with no entry and no minimum, an in-flight version-7 load is refused after invalidateIfOlder(K, 8); a version-8 load is stored', async () => {
      const key = keyIn(uniqueNamespace());
      const gate = new Deferred();
      const inFlight = jest.fn(async () => {
        await gate.promise;
        return { version: 7 };
      });
      const reader = a.cache.getOrLoad(key, inFlight, versioned);
      await waitFor(async () => inFlight.mock.calls.length > 0, {
        description: 'load started',
      });

      expect(await b.cache.invalidateIfOlder(key, 8)).toEqual({
        outcome: 'applied',
      });
      expect((await readMinimum(a.redis, key))?.version).toBe(8);
      gate.resolve();

      expect(await reader).toEqual({ version: 7 });
      expect(await a.redis.client.exists(key)).toBe(0);
      await a.cache.getOrLoad(key, async () => ({ version: 8 }), versioned);
      expect(await a.redis.client.exists(key)).toBe(1);
    });

    it('S52 AS-38: a negative (unversioned) entry is deleted by invalidateIfOlder(K, 1); an unversioned load is refused while a minimum exists', async () => {
      const ns = uniqueNamespace();
      const key = keyIn(ns);
      const negative = {
        ttlMs: 600_000,
        negativeTtlMs: 60_000,
        versionOf: (d: Doc) => d.version,
      };
      await a.cache.getOrLoad(key, async () => null, negative);
      expect(await a.redis.client.exists(key)).toBe(1);

      expect(await a.cache.invalidateIfOlder(key, 1)).toEqual({
        outcome: 'applied',
      });
      expect(await a.redis.client.exists(key)).toBe(0);
      expect((await readMinimum(a.redis, key))?.version).toBe(1);

      const unversioned = {
        ttlMs: 600_000,
        versionOf: () => undefined as unknown as number,
      };
      expect(
        await a.cache.getOrLoad(key, async () => ({ version: 2 }), unversioned),
      ).toEqual({ version: 2 });
      expect(await a.redis.client.exists(key)).toBe(0);
      expect(outcomeCount(ns, 'refused_unversioned')).toBe(1);
    });

    it('S52 AS-39: the minimum lives for the retention on the injected clock; 301 s later any version is accepted again', async () => {
      const key = keyIn(uniqueNamespace());
      await a.cache.invalidateIfOlder(key, 4);
      const minimum = await readMinimum(a.redis, key);
      expect(minimum?.until).toBe(clock.nowMs() + 300_000);
      const pttl = await a.redis.client.pttl(`{${key}}:min`);
      expect(pttl).toBeGreaterThan(299_000);
      expect(pttl).toBeLessThanOrEqual(300_000);

      clock.advance(299_000);
      await a.cache.getOrLoad(key, async () => ({ version: 3 }), versioned);
      expect(await a.redis.client.exists(key)).toBe(0); // still refused

      clock.advance(2_000); // 301 s in total
      await a.cache.getOrLoad(key, async () => ({ version: 3 }), versioned);
      expect(await a.redis.client.exists(key)).toBe(1);
    });

    it.each([
      [999, false],
      [1_000, true],
      [3_600_000, true],
      [3_600_001, false],
    ])(
      'S52 AS-39: a minimum retention of %s ms is accepted: %s',
      async (ms, accepted) => {
        const key = keyIn(uniqueNamespace());
        const call = a.cache.invalidateIfOlder(key, 2, {
          minimumRetentionMs: ms,
        });
        if (accepted)
          await expect(call).resolves.toEqual({ outcome: 'applied' });
        else await expect(call).rejects.toBeInstanceOf(InvalidCacheOptions);
      },
    );

    it.each([-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])(
      'S52 AS-41: invalidateIfOlder with version %s throws and changes nothing',
      async (version) => {
        const key = keyIn(uniqueNamespace());
        await expect(
          a.cache.invalidateIfOlder(key, version),
        ).rejects.toBeInstanceOf(InvalidCacheOptions);
        expect(await readMinimum(a.redis, key)).toBeNull();
      },
    );

    it('S52 SC-003: across 100 scripted replays no late, duplicate or out-of-order event brings an older version back', async () => {
      const event = fc.oneof(
        fc.record({
          type: fc.constant('load' as const),
          version: fc.integer({ min: 0, max: 6 }),
        }),
        fc.record({
          type: fc.constant('invalidate' as const),
          version: fc.integer({ min: 0, max: 6 }),
        }),
      );
      await fc.assert(
        fc.asyncProperty(
          fc.array(event, { minLength: 1, maxLength: 12 }),
          async (events) => {
            const key = keyIn(uniqueNamespace('replay'));
            // The newest version any *applied* invalidation has declared the minimum: nothing older may reappear.
            let highest = 0;
            for (const e of events) {
              if (e.type === 'invalidate') {
                const { outcome } = await a.cache.invalidateIfOlder(
                  key,
                  e.version,
                );
                if (outcome === 'applied')
                  highest = Math.max(highest, e.version);
              } else {
                await a.redis.client.del(key); // the previous entry expired
                await a.cache.getOrLoad(
                  key,
                  async () => ({ version: e.version }),
                  versioned,
                );
              }
              const raw = await a.redis.client.get(key);
              if (raw !== null) {
                const ver = JSON.parse(raw).ver as number;
                if (ver < highest) return false;
              }
            }
            return true;
          },
        ),
        { numRuns: 100 },
      );
    }, 120_000);
  });
});
