import { FakeClock } from '@app/common/core/clock';
import { inParallel } from '@app/test/utils/async-helpers';
import {
  LimiterInstance,
  T0,
  createLimiter,
  evalCalls,
  uniqueSubject,
} from './test/limiter-fixture';

/** S50 US4: a hot key costs few store calls, and the fleet never exceeds the budget. Real Redis. */
describe('S50 local lease (e2e, real Redis)', () => {
  let a: LimiterInstance;
  let clock: FakeClock;

  beforeEach(async () => {
    clock = new FakeClock();
    a = await createLimiter({ clock });
    a.manualTime.set(T0);
  });

  afterEach(async () => {
    await a.close();
  });

  const allowedOf = (results: PromiseSettledResult<{ allowed: boolean }>[]) =>
    results.filter((r) => r.status === 'fulfilled' && r.value.allowed).length;

  it('S50 AS-21: 200 parallel checks on a hot key admit 54 to 60 with at most 40 store calls', async () => {
    const subject = uniqueSubject();
    const before = await evalCalls(a.redis);
    const results = await inParallel(200, () =>
      a.limiter.check('probe.hot', subject),
    );
    const calls = (await evalCalls(a.redis)) - before;
    const allowed = allowedOf(results);
    expect(allowed).toBeLessThanOrEqual(60);
    expect(allowed).toBeGreaterThanOrEqual(54);
    expect(calls).toBeLessThanOrEqual(40);
    const sources = new Set(
      results.map(
        (r) => (r as PromiseFulfilledResult<{ source: string }>).value.source,
      ),
    );
    expect(sources.has('local-lease')).toBe(true);
  });

  it('S50 AS-22: the lease lasts one second; unspent tokens are dropped, not returned', async () => {
    const subject = uniqueSubject();
    const first = await a.limiter.check('probe.hot', subject);
    expect(first).toMatchObject({ allowed: true, source: 'store' });
    const bucket = `rl:{probe.hot|${subject}}:tb`;
    expect(Number(await a.redis.client.hget(bucket, 'tokens'))).toBe(54); // slice of 6 taken

    const callsBefore = await evalCalls(a.redis);
    const second = await a.limiter.check('probe.hot', subject);
    expect(second).toMatchObject({
      allowed: true,
      source: 'local-lease',
      remaining: 4,
    });
    expect(await evalCalls(a.redis)).toBe(callsBefore);

    clock.advance(1_001);
    const third = await a.limiter.check('probe.hot', subject);
    expect(third.source).toBe('store');
    expect(await evalCalls(a.redis)).toBe(callsBefore + 1);
    // 5 → 4 unspent tokens were dropped; the next slice came out of the store's 54
    expect(Number(await a.redis.client.hget(bucket, 'tokens'))).toBe(48);
  });

  it('S50 AS-23: two instances on one hot key admit 48 to 60 in total', async () => {
    const b = await createLimiter({ clock: new FakeClock() });
    try {
      const subject = uniqueSubject();
      const results = await inParallel(200, (i) =>
        (i % 2 ? a : b).limiter.check('probe.hot', subject),
      );
      const allowed = allowedOf(results);
      expect(allowed).toBeLessThanOrEqual(60);
      expect(allowed).toBeGreaterThanOrEqual(48);
    } finally {
      await b.close();
    }
  });

  it('S50 AS-24: no lease for cost above 1, for a policy without a fraction, or for other algorithms', async () => {
    const subject = uniqueSubject();
    let before = await evalCalls(a.redis);
    for (let i = 0; i < 5; i++) await a.limiter.check('probe.hot', subject, 2);
    expect(await evalCalls(a.redis)).toBe(before + 5);

    before = await evalCalls(a.redis);
    for (let i = 0; i < 5; i++) {
      const d = await a.limiter.check('probe.no-lease', subject);
      expect(d.source).toBe('store');
    }
    expect(await evalCalls(a.redis)).toBe(before + 5);

    before = await evalCalls(a.redis);
    for (let i = 0; i < 5; i++)
      await a.limiter.check('probe.window100', subject);
    expect(await evalCalls(a.redis)).toBe(before + 5);
  });

  it('S50 AS-25: after a denial the instance answers locally for a moment, then asks the store again', async () => {
    const subject = uniqueSubject();
    let allowed = 0;
    for (let i = 0; i < 60; i++)
      if ((await a.limiter.check('probe.hot', subject)).allowed) allowed++;
    expect(allowed).toBe(60);

    const denied = await a.limiter.check('probe.hot', subject);
    expect(denied).toMatchObject({
      allowed: false,
      reason: 'limit-exceeded',
      source: 'store',
    });
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1_000);

    const before = await evalCalls(a.redis);
    for (let i = 0; i < 5; i++) {
      const local = await a.limiter.check('probe.hot', subject);
      expect(local).toMatchObject({ allowed: false, source: 'local-lease' });
    }
    expect(await evalCalls(a.redis)).toBe(before);

    clock.advance(1_000);
    const again = await a.limiter.check('probe.hot', subject);
    expect(again.source).toBe('store');
    expect(await evalCalls(a.redis)).toBe(before + 1);
  });
});
