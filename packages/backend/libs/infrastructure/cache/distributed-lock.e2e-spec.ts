import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import { DistributedLock, Lock } from './distributed-lock';
import {
  InvalidCacheOptions,
  LockTimeout,
  LockUnavailable,
} from './cache.errors';
import {
  CacheInstance,
  countStoreCalls,
  createCacheInstance,
  proxyUrl,
  startStoreProxy,
  uniqueNamespace,
} from './testing/cache-fixture.module';

const resourceName = () => `${uniqueNamespace('res')}:E1`;
const lockKey = (resource: string) => `lock:{${resource}}`;
const fenceKey = (resource: string) => `lock:{${resource}}:fence`;
const acquisitions = (outcome: string) =>
  MetricsRegistry.value('cache_lock_acquisitions_total', { outcome }) ?? 0;

describe('Distributed lock with fencing tokens', () => {
  let one: CacheInstance;
  let two: CacheInstance;
  let three: CacheInstance;
  let l1: DistributedLock;
  let l2: DistributedLock;
  let l3: DistributedLock;

  beforeAll(async () => {
    [one, two, three] = await Promise.all([
      createCacheInstance(),
      createCacheInstance(),
      createCacheInstance(),
    ]);
    l1 = new DistributedLock(one.redis);
    l2 = new DistributedLock(two.redis);
    l3 = new DistributedLock(three.redis);
  });

  afterAll(async () => {
    await Promise.all([one.close(), two.close(), three.close()]);
  });

  it('S52 AS-57: 20 concurrent tryAcquire calls produce exactly one lock', async () => {
    const resource = resourceName();
    const acquiredBefore = acquisitions('acquired');
    const contendedBefore = acquisitions('contended');

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        [l1, l2, l3][i % 3].tryAcquire(resource, { ttlMs: 5_000 }),
      ),
    );

    const winners = results.filter((r): r is Lock => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ resource, fence: 1 });
    expect(typeof winners[0].token).toBe('string');
    expect(await one.redis.client.get(lockKey(resource))).toBe(
      winners[0].token,
    );
    expect(acquisitions('acquired')).toBe(acquiredBefore + 1);
    expect(acquisitions('contended')).toBe(contendedBefore + 19);
  });

  it('S52 AS-58: a holder whose lock expired cannot release the next holder’s lock; release is owned and atomic', async () => {
    const resource = resourceName();
    const a = (await l1.tryAcquire(resource, { ttlMs: 100 }))!;
    await waitFor(
      async () => (await one.redis.client.exists(lockKey(resource))) === 0,
      {
        description: 'A’s lock expired',
      },
    );
    const b = (await l2.tryAcquire(resource, { ttlMs: 5_000 }))!;
    expect(b).not.toBeNull();

    expect(await a.release()).toBe(false);
    expect(await one.redis.client.get(lockKey(resource))).toBe(b.token);

    expect(await b.release()).toBe(true);
    expect(await one.redis.client.exists(lockKey(resource))).toBe(0);
    expect(await b.release()).toBe(false);
    expect(await l3.tryAcquire(resource, { ttlMs: 1_000 })).not.toBeNull();
  });

  it('S52 AS-59: fences strictly increase across release, expiry and instances, and a protected write can tell the stale holder', async () => {
    const resource = resourceName();
    const first = (await l1.tryAcquire(resource, { ttlMs: 5_000 }))!;
    await first.release();
    const second = (await l2.tryAcquire(resource, { ttlMs: 100 }))!;
    await waitFor(
      async () => (await one.redis.client.exists(lockKey(resource))) === 0,
    );
    const third = (await l3.tryAcquire(resource, { ttlMs: 5_000 }))!;

    expect([first.fence, second.fence, third.fence]).toEqual([1, 2, 3]);
    const retention = await one.redis.client.pttl(fenceKey(resource));
    expect(retention).toBeGreaterThan(30 * 24 * 3_600_000 - 5_000);
    expect(retention).toBeLessThanOrEqual(30 * 24 * 3_600_000);

    // A protected write guarded by `fence < presented`: the newest holder passes, the stale one is refused.
    let stored = 0;
    const protectedWrite = (presented: number) => {
      if (!l1.isNewerFence(stored, presented)) return false;
      stored = presented;
      return true;
    };
    expect(protectedWrite(third.fence)).toBe(true);
    expect(protectedWrite(second.fence)).toBe(false);
  });

  it.each([
    [1, 2, true],
    [5, 6, true],
    [5, 5, false],
    [5, 4, false],
    [0, 1, true],
  ])(
    'S52 AS-59: isNewerFence(%s, %s) is %s',
    (current, presented, expected) => {
      expect(l1.isNewerFence(current, presented)).toBe(expected);
    },
  );

  describe('S52 AS-60: extend and withLock', () => {
    it('S52 AS-60: the holder extends before expiry and restarts the lifetime; after losing the lock extend returns false and leaves the new holder alone', async () => {
      const resource = resourceName();
      const a = (await l1.tryAcquire(resource, { ttlMs: 5_000 }))!;

      expect(await a.extend(20_000)).toBe(true);
      expect(await one.redis.client.pttl(lockKey(resource))).toBeGreaterThan(
        19_000,
      );

      await one.redis.client.del(lockKey(resource)); // A’s lock was lost
      const b = (await l2.tryAcquire(resource, { ttlMs: 7_000 }))!;
      expect(await a.extend(60_000)).toBe(false);
      expect(await one.redis.client.get(lockKey(resource))).toBe(b.token);
      expect(
        await one.redis.client.pttl(lockKey(resource)),
      ).toBeLessThanOrEqual(7_000);
    });

    it('S52 AS-60: withLock passes the lock to fn and releases afterwards, also when fn throws', async () => {
      const resource = resourceName();
      const result = await l1.withLock(
        resource,
        { ttlMs: 5_000 },
        async (lock) => {
          expect(await one.redis.client.get(lockKey(resource))).toBe(
            lock.token,
          );
          expect(await lock.extend(8_000)).toBe(true);
          return 'done';
        },
      );
      expect(result).toBe('done');
      expect(await one.redis.client.exists(lockKey(resource))).toBe(0);

      await expect(
        l1.withLock(resource, { ttlMs: 5_000 }, async () => {
          throw new Error('work failed');
        }),
      ).rejects.toThrow('work failed');
      expect(await one.redis.client.exists(lockKey(resource))).toBe(0);
    });

    it('S52 AS-60: withLock on a held resource rejects with LockTimeout instead of running fn', async () => {
      const resource = resourceName();
      await l2.tryAcquire(resource, { ttlMs: 5_000 });
      const fn = jest.fn(async () => 'x');
      await expect(
        l1.withLock(resource, { ttlMs: 5_000 }, fn),
      ).rejects.toBeInstanceOf(LockTimeout);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('S52 AS-61: waiting', () => {
    it('S52 AS-61: acquire returns shortly after the holder releases, polling with jitter rather than spinning', async () => {
      const resource = resourceName();
      const holder = (await l1.tryAcquire(resource, { ttlMs: 5_000 }))!;
      setTimeout(() => void holder.release(), 300);

      const started = Date.now();
      let lock: Lock | undefined;
      const commands = await countStoreCalls(two.redis, async () => {
        lock = await l2.acquire(resource, { ttlMs: 5_000, waitMs: 1_000 });
      });
      const waited = Date.now() - started;

      expect(lock?.fence).toBe(2);
      expect(waited).toBeGreaterThanOrEqual(250);
      expect(waited).toBeLessThan(700);
      expect(commands).toBeLessThanOrEqual(45); // at most one attempt per ~10 ms, never a tight loop
    });

    it('S52 AS-61: with waitMs 100 and a holder for 1 s, acquire rejects with LockTimeout after 100 ms ± 50', async () => {
      const resource = resourceName();
      await l1.tryAcquire(resource, { ttlMs: 1_000 });
      const timeouts = acquisitions('timeout');

      const started = Date.now();
      const error = await l2
        .acquire(resource, { ttlMs: 1_000, waitMs: 100 })
        .catch((e) => e);
      const waited = Date.now() - started;

      expect(error).toBeInstanceOf(LockTimeout);
      expect(error.status).toBe(503);
      expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(waited).toBeGreaterThanOrEqual(90);
      expect(waited).toBeLessThanOrEqual(150);
      expect(acquisitions('timeout')).toBe(timeouts + 1);
    });
  });

  it.each([
    ['ttl below 100', (r: string) => l1.tryAcquire(r, { ttlMs: 99 })],
    ['ttl above 600,000', (r: string) => l1.tryAcquire(r, { ttlMs: 600_001 })],
    [
      'a wait above 600,000',
      (r: string) => l1.acquire(r, { ttlMs: 1_000, waitMs: 600_001 }),
    ],
    ['an empty resource', () => l1.tryAcquire('', { ttlMs: 1_000 })],
    [
      'a resource with whitespace',
      () => l1.tryAcquire('a b', { ttlMs: 1_000 }),
    ],
    [
      'an oversized resource',
      () => l1.tryAcquire('r'.repeat(257), { ttlMs: 1_000 }),
    ],
  ])(
    'S52 AS-63: %s is rejected with InvalidCacheOptions before the store is touched',
    async (_name, call) => {
      await expect(call(resourceName())).rejects.toBeInstanceOf(
        InvalidCacheOptions,
      );
    },
  );

  describe('S52 AS-62: fail closed', () => {
    let proxy: TcpFaultProxy;
    let broken: CacheInstance;

    beforeAll(async () => {
      proxy = await startStoreProxy();
      broken = await createCacheInstance({ clientUrl: proxyUrl(proxy) });
    });
    afterAll(async () => {
      await broken.close();
      await proxy.close();
    });

    it('S52 AS-62: with the store down tryAcquire and acquire reject with LockUnavailable and never return a lock', async () => {
      const lock = new DistributedLock(broken.redis);
      const resource = resourceName();
      const unavailable = acquisitions('unavailable');

      proxy.mode = 'refuse';
      proxy.sever();
      await waitFor(async () => broken.redis.client.status !== 'ready', {
        description: 'connection loss noticed',
      });
      await expect(
        lock.tryAcquire(resource, { ttlMs: 1_000 }),
      ).rejects.toBeInstanceOf(LockUnavailable);
      await expect(
        lock.acquire(resource, { ttlMs: 1_000, waitMs: 100 }),
      ).rejects.toBeInstanceOf(LockUnavailable);
      expect(acquisitions('unavailable')).toBe(unavailable + 2);
      proxy.mode = 'pass';
      expect(await one.redis.client.exists(lockKey(resource))).toBe(0);
    });
  });
});
