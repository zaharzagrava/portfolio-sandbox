import { FakeClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import { CacheUnavailable, CounterOverflow } from './cache.errors';
import {
  CacheInstance,
  createCacheInstance,
  proxyUrl,
  startStoreProxy,
  uniqueNamespace,
} from './testing/cache-fixture.module';
import { WriteBehindCounter } from './write-behind-counter';

const pending = (name: string) =>
  MetricsRegistry.value('cache_counter_pending_members', { counter: name });
const toObject = (map: Map<string, number>) => Object.fromEntries(map);

describe('Write-behind counters', () => {
  const clock = new FakeClock();
  let one: CacheInstance;
  let two: CacheInstance;

  beforeAll(async () => {
    one = await createCacheInstance({ clock });
    two = await createCacheInstance({ clock });
  });

  afterAll(async () => {
    await Promise.all([one.close(), two.close()]);
  });

  const counterOn = (inst: CacheInstance, name: string, options = {}) =>
    new WriteBehindCounter(inst.redis, name, { clock, ...options });

  it('S52 AS-49: two instances making 5,000 increments of "a" and 5,000 of "b" by 2 each drain to exact totals, then to nothing', async () => {
    const name = uniqueNamespace('ctr');
    const x = counterOn(one, name);
    const y = counterOn(two, name);

    // 5,000 + 5,000 per instance, released in bursts of 2,500 concurrent calls (a single 20,000-call burst would
    // queue past the 250 ms store timeout, which is the toolkit working as designed).
    for (let burst = 0; burst < 4; burst++)
      await Promise.all(
        [x, y].flatMap((c) => [
          ...Array.from({ length: 1_250 }, () => c.increment('a')),
          ...Array.from({ length: 1_250 }, () => c.increment('b', 2)),
        ]),
      );

    expect(toObject(await x.drain())).toEqual({ a: 10_000, b: 20_000 });
    expect((await y.drain()).size).toBe(0);
    expect(await one.redis.client.exists(`counter:{${name}}:pending`)).toBe(0);
  });

  it('S52 AS-50: 20,000 increments racing a 5 ms drain loop are neither lost nor counted twice', async () => {
    const name = uniqueNamespace('ctr');
    const writer = counterOn(one, name);
    const flusher = counterOn(two, name);
    let drained = 0;
    let done = false;
    const loop = (async () => {
      while (!done) {
        for (const delta of (await flusher.drain()).values()) drained += delta;
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    for (let i = 0; i < 20_000; i += 1_000)
      await Promise.all(
        Array.from({ length: 1_000 }, (_, j) =>
          writer.increment(`m${(i + j) % 7}`),
        ),
      );
    done = true;
    await loop;
    for (const delta of (await flusher.drain()).values()) drained += delta;

    expect(drained).toBe(20_000);
  });

  it('S52 AS-51: restore merges a failed flush back with increments made since', async () => {
    const name = uniqueNamespace('ctr');
    const c = counterOn(one, name);
    await c.increment('a', 50);
    await c.increment('b', 50);
    const batch = await c.drain();
    expect(toObject(batch)).toEqual({ a: 50, b: 50 });

    for (let i = 0; i < 10; i++) await c.increment('a');
    await c.restore(batch);

    expect(toObject(await c.drain())).toEqual({ a: 60, b: 50 });
  });

  describe('S52 AS-52: crash-safe claim', () => {
    it('S52 AS-52: a claimed batch whose flusher died returns to pending after the claim age, and a late commit is a no-op', async () => {
      const name = uniqueNamespace('ctr');
      const c = counterOn(one, name);
      await c.increment('a', 5);
      await c.increment('b', -2);

      const claimed = await c.claim();
      expect(toObject(claimed.deltas)).toEqual({ a: 5, b: -2 });
      expect(await one.redis.client.exists(`counter:{${name}}:pending`)).toBe(
        0,
      );
      expect(
        await one.redis.client.exists(
          `counter:{${name}}:claim:${claimed.batchId}`,
        ),
      ).toBe(1);

      clock.advance(5 * 60_000 - 1);
      expect(await c.reclaimExpired()).toBe(0); // not old enough yet
      clock.advance(1);
      expect(await c.reclaimExpired()).toBe(1);
      expect(await c.reclaimExpired()).toBe(0);

      expect(await c.commit(claimed.batchId)).toEqual({ committed: false }); // already merged back
      expect(toObject(await c.drain())).toEqual({ a: 5, b: -2 });
    });

    it('S52 AS-52: commit removes a batch for good; a second commit and an unknown id are no-ops', async () => {
      const name = uniqueNamespace('ctr');
      const c = counterOn(one, name);
      await c.increment('a', 3);
      const claimed = await c.claim();

      expect(await c.commit(claimed.batchId)).toEqual({ committed: true });
      expect(await c.commit(claimed.batchId)).toEqual({ committed: false });
      expect(await c.commit('not-a-batch')).toEqual({ committed: false });
      clock.advance(10 * 60_000);
      expect(await c.reclaimExpired()).toBe(0);
      expect((await c.drain()).size).toBe(0);
    });

    it('S52 AS-52: release merges a batch back at once, with increments made since', async () => {
      const name = uniqueNamespace('ctr');
      const c = counterOn(one, name);
      await c.increment('a', 3);
      const claimed = await c.claim();
      await c.increment('a', 4);

      await c.release(claimed.batchId);
      await c.release(claimed.batchId); // twice changes nothing

      expect(toObject(await c.drain())).toEqual({ a: 7 });
    });

    it('S52 AS-52: claim on an empty counter returns no deltas and records nothing', async () => {
      const c = counterOn(one, uniqueNamespace('ctr'));
      const claimed = await c.claim();
      expect(claimed.deltas.size).toBe(0);
      expect(await c.commit(claimed.batchId)).toEqual({ committed: false });
    });
  });

  it('S52 AS-54: at the pending-member cap a new member is refused, existing members still count, and a drain frees room', async () => {
    const name = uniqueNamespace('ctr');
    const c = counterOn(one, name, { pendingCap: 50 });
    for (let i = 0; i < 50; i++) await c.increment(`m${i}`);
    expect(pending(name)).toBe(50);

    await expect(c.increment('one-too-many')).rejects.toBeInstanceOf(
      CounterOverflow,
    );
    expect(
      MetricsRegistry.value('cache_counter_overflow_total', { counter: name }),
    ).toBe(1);
    await c.increment('m0', 4);

    const drained = await c.drain();
    expect(drained.get('m0')).toBe(5);
    expect(drained.has('one-too-many')).toBe(false);
    expect(pending(name)).toBe(0);
    await c.increment('one-too-many');
    expect(toObject(await c.drain())).toEqual({ 'one-too-many': 1 });
  });

  it('S52 AS-55: the same member in two counters never mixes, and draining one leaves the other', async () => {
    const views = counterOn(one, uniqueNamespace('product-views'));
    const votes = counterOn(two, uniqueNamespace('vote-deltas'));
    await views.increment('p1', 5);
    await votes.increment('p1', -3);

    expect(toObject(await views.drain())).toEqual({ p1: 5 });
    expect(toObject(await votes.drain())).toEqual({ p1: -3 });
  });

  describe('S52 AS-56: store down', () => {
    let proxy: TcpFaultProxy;
    let broken: CacheInstance;

    beforeAll(async () => {
      proxy = await startStoreProxy();
      broken = await createCacheInstance({ clock, clientUrl: proxyUrl(proxy) });
    });
    afterAll(async () => {
      await broken.close();
      await proxy.close();
    });

    it('S52 AS-56: increment, drain and claim reject with CacheUnavailable and nothing already staged is lost', async () => {
      const name = uniqueNamespace('ctr');
      const c = counterOn(broken, name);
      await c.increment('a', 2);
      await c.increment('b', 3);

      proxy.mode = 'refuse';
      proxy.sever();
      // Wait until the client knows it is disconnected: a command written to a dying socket may be re-sent
      // by ioredis after the reconnect, which is a different scenario from "the store is down".
      await waitFor(async () => broken.redis.client.status !== 'ready', {
        description: 'connection loss noticed',
      });
      await expect(c.increment('a')).rejects.toBeInstanceOf(CacheUnavailable);
      await expect(c.drain()).rejects.toBeInstanceOf(CacheUnavailable);
      await expect(c.claim()).rejects.toBeInstanceOf(CacheUnavailable);

      proxy.mode = 'pass';
      await waitFor(async () => (await broken.redis.client.ping()) === 'PONG', {
        timeoutMs: 15_000,
        description: 'reconnected',
      });
      clock.advance(5_001); // the breaker may have opened
      expect(toObject(await c.drain())).toEqual({ a: 2, b: 3 });
    });
  });
});
