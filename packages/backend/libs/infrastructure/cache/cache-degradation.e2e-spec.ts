import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { FakeClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import { CacheLoaderBusy, LockUnavailable } from './cache.errors';
import { DistributedLock } from './distributed-lock';
import {
  CacheInstance,
  createCacheInstance,
  Deferred,
  outcomeCount,
  proxyUrl,
  ScriptedRandom,
  startStoreProxy,
  uniqueNamespace,
} from './testing/cache-fixture.module';

const keyIn = (ns: string, id: string = randomUUID()) => `${ns}:v1:${id}`;
const later = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const breakerGauge = () => MetricsRegistry.value('cache_breaker_state');

describe('Cache degradation (store down, hanging, overloaded)', () => {
  let proxy: TcpFaultProxy;
  let direct: CacheInstance;
  const open: CacheInstance[] = [];

  /** An instance whose command connection runs through the fault proxy; the subscriber stays direct. */
  const viaProxy = async (
    extra: Parameters<typeof createCacheInstance>[0] = {},
  ): Promise<CacheInstance> => {
    const inst = await createCacheInstance({
      clientUrl: proxyUrl(proxy),
      random: ScriptedRandom.constant(0.5),
      ...extra,
    });
    open.push(inst);
    return inst;
  };

  beforeAll(async () => {
    proxy = await startStoreProxy();
    direct = await createCacheInstance();
  });

  afterEach(async () => {
    proxy.mode = 'pass';
    proxy.delayMs = 0;
    await Promise.all(open.splice(0).map((i) => i.close()));
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await direct.close();
    await proxy.close();
  });

  const breakStore = (mode: 'refuse' | 'hang') => {
    proxy.mode = mode;
    proxy.sever();
  };
  const restoreStore = async (inst: CacheInstance) => {
    proxy.mode = 'pass';
    await waitFor(async () => (await inst.redis.client.ping()) === 'PONG', {
      timeoutMs: 15_000,
      description: 'command connection reconnected',
    });
  };

  it('S52 AS-42: with the store refusing, 100 concurrent reads all get the loader’s value from one load, store nothing and log one warning', async () => {
    const inst = await viaProxy();
    const ns = uniqueNamespace();
    const key = keyIn(ns);
    const loader = jest.fn(() => later(100, 'from-source'));
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    breakStore('refuse');
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        inst.cache.getOrLoad(key, loader, { ttlMs: 60_000 }),
      ),
    );

    expect(results.every((r) => r === 'from-source')).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(100 + 250 + 500); // loader plus at most one store timeout
    expect(await direct.redis.client.exists(key)).toBe(0);
    expect(outcomeCount(ns, 'degraded')).toBe(100);
    const lines = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes(`namespace=${ns}`));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(key);
  });

  it('S52 AS-43: a store that accepts but never answers is abandoned after 250 ms, and a per-call timeoutMs of 50 is honoured', async () => {
    const inst = await viaProxy();
    const ns = uniqueNamespace();
    const loader = jest.fn(async () => 'from-source');

    breakStore('hang');
    let started = Date.now();
    expect(
      await inst.cache.getOrLoad(keyIn(ns), loader, { ttlMs: 60_000 }),
    ).toBe('from-source');
    const defaultWait = Date.now() - started;
    expect(defaultWait).toBeGreaterThanOrEqual(240);
    expect(defaultWait).toBeLessThan(700);

    started = Date.now();
    expect(
      await inst.cache.getOrLoad(keyIn(ns), loader, {
        ttlMs: 60_000,
        timeoutMs: 50,
      }),
    ).toBe('from-source');
    const shortWait = Date.now() - started;
    expect(shortWait).toBeGreaterThanOrEqual(45);
    expect(shortWait).toBeLessThan(200);
    expect(outcomeCount(ns, 'degraded')).toBe(2);
  });

  it('S52 AS-44: five consecutive failures open the breaker for 5 s, one probe then closes or re-opens it, with a gauge and one log per transition', async () => {
    const clock = new FakeClock();
    const inst = await viaProxy({ clock });
    const ns = uniqueNamespace();
    const loader = jest.fn(async () => 'v');
    const info = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const transitions = () =>
      info.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('store breaker'));
    const read = () =>
      inst.cache.getOrLoad(keyIn(ns), loader, { ttlMs: 60_000 });

    expect(breakerGauge()).toBe(0);
    breakStore('refuse');
    for (let i = 0; i < 5; i++) await read();
    expect(inst.cache.stats().breaker).toBe('open');
    expect(breakerGauge()).toBe(1);

    // While open the store is not contacted at all, even though it is reachable again.
    await restoreStore(inst);
    const chunks = proxy.clientChunks;
    clock.advance(4_999);
    for (let i = 0; i < 10; i++) await read();
    expect(proxy.clientChunks).toBe(chunks);
    expect(inst.cache.stats().breaker).toBe('open');

    // After 5 s one probe is allowed; a failed probe re-opens for another 5 s.
    clock.advance(2);
    expect(inst.cache.stats().breaker).toBe('half-open');
    expect(breakerGauge()).toBe(2);
    breakStore('refuse');
    await read();
    expect(inst.cache.stats().breaker).toBe('open');
    expect(breakerGauge()).toBe(1);

    // A successful probe closes it.
    clock.advance(5_001);
    await restoreStore(inst);
    expect(inst.cache.stats().breaker).toBe('half-open');
    await read();
    expect(inst.cache.stats().breaker).toBe('closed');
    expect(breakerGauge()).toBe(0);

    expect(
      transitions().map((l) =>
        /store breaker (\S+) -> (\S+)/.exec(l)!.slice(1).join('>'),
      ),
    ).toEqual([
      'closed>open',
      'open>half-open',
      'half-open>open',
      'open>half-open',
      'half-open>closed',
    ]);
  });

  it('S52 AS-45: with the store down at most 100 loaders run, the rest queue in arrival order and the overflow is rejected with CacheLoaderBusy', async () => {
    const inst = await viaProxy({ config: { loaderQueueWaitMs: 400 } });
    const ns = uniqueNamespace();
    const gate = new Deferred();
    let running = 0;
    let peak = 0;
    const loaderFor = (i: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      await gate.promise;
      running--;
      return i;
    };

    breakStore('refuse');
    const reads = Array.from({ length: 500 }, (_, i) =>
      inst.cache.getOrLoad(keyIn(ns, `k${i}`), loaderFor(i), { ttlMs: 60_000 }),
    );
    const settled = reads.map((p) =>
      p.then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e }),
      ),
    );

    await waitFor(async () => inst.cache.stats().loadersRunning === 100, {
      description: 'cap reached',
    });
    await later(600, undefined); // the queue wait (400 ms) passes
    gate.resolve();
    const results = await Promise.all(settled);

    expect(peak).toBeLessThanOrEqual(100);
    const served = results.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0);
    expect(served).toHaveLength(100);
    expect(served).toEqual([...served].sort((x, y) => x - y)); // values match their own key
    const rejected = results.filter((r) => !r.ok) as {
      ok: false;
      e: unknown;
    }[];
    expect(rejected).toHaveLength(400);
    expect(rejected.every((r) => r.e instanceof CacheLoaderBusy)).toBe(true);
    const busy = rejected[0].e as CacheLoaderBusy;
    expect(busy.status).toBe(503);
    expect(busy.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(inst.cache.stats()).toMatchObject({
      loadersRunning: 0,
      loadersQueued: 0,
      inFlight: 0,
    });
  });

  it('S52 AS-46: after the store returns the key is stored again and the next read is an L2 hit', async () => {
    const clock = new FakeClock();
    const inst = await viaProxy({ clock });
    const ns = uniqueNamespace();
    const key = keyIn(ns);
    const loader = jest.fn(async () => 'v');

    breakStore('refuse');
    expect(await inst.cache.getOrLoad(key, loader, { ttlMs: 60_000 })).toBe(
      'v',
    );
    expect(await direct.redis.client.exists(key)).toBe(0);

    await restoreStore(inst);
    clock.advance(5_001); // in case the breaker opened meanwhile
    expect(await inst.cache.getOrLoad(key, loader, { ttlMs: 60_000 })).toBe(
      'v',
    );
    expect(await direct.redis.client.exists(key)).toBe(1);
    expect(await inst.cache.getOrLoad(key, loader, { ttlMs: 60_000 })).toBe(
      'v',
    );
    expect(outcomeCount(ns, 'l2')).toBe(1);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('S52 AS-47: with the store down a read proceeds without the recompute lock, while DistributedLock.tryAcquire fails closed', async () => {
    const inst = await viaProxy();
    const ns = uniqueNamespace();
    const key = keyIn(ns);
    const loader = jest.fn(async () => 'v');
    const lock = new DistributedLock(inst.redis);

    breakStore('refuse');
    await waitFor(async () => inst.redis.client.status !== 'ready', {
      description: 'connection loss noticed',
    });

    expect(await inst.cache.getOrLoad(key, loader, { ttlMs: 60_000 })).toBe(
      'v',
    ); // efficiency lock: fail open
    expect(loader).toHaveBeenCalledTimes(1);
    await expect(
      lock.tryAcquire(`res${ns}`, { ttlMs: 1_000 }),
    ).rejects.toBeInstanceOf(LockUnavailable); // correctness lock: fail closed
  });

  it('S52 AS-48: with the store down an l1-always key is still served from L1 within l1TtlMs, then read from the loader', async () => {
    const clock = new FakeClock();
    const inst = await viaProxy({ clock });
    const ns = uniqueNamespace();
    const key = keyIn(ns);
    const loader = jest.fn(async () => 'v');
    const options = { ttlMs: 600_000, l1: 'always' as const, l1TtlMs: 1_000 };
    await inst.cache.getOrLoad(key, loader, options);
    expect(inst.cache.l1Has(key)).toBe(true);

    breakStore('refuse');
    expect(await inst.cache.getOrLoad(key, loader, options)).toBe('v');
    expect(outcomeCount(ns, 'l1')).toBe(1);
    expect(outcomeCount(ns, 'degraded')).toBe(0);

    clock.advance(1_001);
    expect(await inst.cache.getOrLoad(key, loader, options)).toBe('v');
    expect(outcomeCount(ns, 'degraded')).toBe(1);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
