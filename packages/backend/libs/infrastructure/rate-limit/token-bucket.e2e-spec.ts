import { definePolicies } from './policy';
import { InvalidRateLimitCostError } from './rate-limit.errors';
import {
  LimiterInstance,
  T0,
  createLimiter,
  storedItems,
  uniqueSubject,
} from './test/limiter-fixture';
import { inParallel } from '@app/test/utils/async-helpers';

/** S50 US1: token bucket against the real test Redis, store time driven through the injectable time source. */
describe('S50 token bucket (e2e, real Redis)', () => {
  let a: LimiterInstance;

  beforeAll(async () => {
    a = await createLimiter();
  });

  afterAll(async () => {
    await a.close();
  });

  const allowedOf = (
    results: PromiseSettledResult<{ allowed: boolean }>[],
  ): number =>
    results.filter((r) => r.status === 'fulfilled' && r.value.allowed).length;

  it('S50 AS-01: 50 parallel checks against burst 10 → exactly 10 allowed, remaining 9 down to 0', async () => {
    const subject = uniqueSubject();
    const results = await inParallel(50, () =>
      a.limiter.check('probe.burst', subject),
    );
    const decisions = results.map(
      (r) =>
        (
          r as PromiseFulfilledResult<
            Awaited<ReturnType<typeof a.limiter.check>>
          >
        ).value,
    );
    const allowed = decisions.filter((d) => d.allowed);
    const denied = decisions.filter((d) => !d.allowed);
    expect(allowed).toHaveLength(10);
    expect(denied).toHaveLength(40);
    expect(denied.every((d) => d.reason === 'limit-exceeded')).toBe(true);
    expect(allowed.map((d) => d.remaining).sort((x, y) => y - x)).toEqual([
      9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
    ]);
    for (const d of decisions) {
      expect(d.remaining).toBeGreaterThanOrEqual(0);
      expect(d.remaining).toBeLessThanOrEqual(d.limit);
      expect(d.limit).toBe(10);
      expect(d.policy).toBe('probe.burst');
      expect(d.source).toBe('store');
    }
  });

  it('S50 AS-02: one token after one refill interval; the denial says when the next one comes', async () => {
    const subject = uniqueSubject();
    for (let i = 0; i < 10; i++) await a.limiter.check('probe.burst', subject);
    const empty = await a.limiter.check('probe.burst', subject);
    expect(empty.allowed).toBe(false);
    expect(empty.retryAfterMs).toBeGreaterThan(0);
    expect(empty.retryAfterMs).toBeLessThanOrEqual(6000);

    a.manualTime.advance(6_000);
    expect((await a.limiter.check('probe.burst', subject)).allowed).toBe(true);
    const next = await a.limiter.check('probe.burst', subject);
    expect(next.allowed).toBe(false);
    expect(next.retryAfterMs).toBeGreaterThan(0);
    expect(next.retryAfterMs).toBeLessThanOrEqual(6000);
  });

  it('S50 AS-03: a bucket idle for 10 times its time-to-full still admits only its capacity', async () => {
    const subject = uniqueSubject();
    await a.limiter.check('probe.burst', subject);
    a.manualTime.advance(10 * 60_000);
    const results = await inParallel(50, () =>
      a.limiter.check('probe.burst', subject),
    );
    expect(allowedOf(results)).toBe(10);
  });

  it('S50 AS-04: subjects and policies are independent', async () => {
    const one = uniqueSubject();
    const two = uniqueSubject();
    for (let i = 0; i < 10; i++) await a.limiter.check('probe.burst', one);
    expect((await a.limiter.check('probe.burst', one)).allowed).toBe(false);
    const other = await a.limiter.check('probe.burst', two);
    expect(other).toMatchObject({ allowed: true, remaining: 9 });
    const otherPolicy = await a.limiter.check('probe.burst-b', one);
    expect(otherPolicy).toMatchObject({ allowed: true, remaining: 9 });
  });

  it('S50 AS-05: weighted cost; a denial consumes nothing', async () => {
    const subject = uniqueSubject();
    const first = await a.limiter.check('probe.burst', subject, 4);
    const second = await a.limiter.check('probe.burst', subject, 4);
    const third = await a.limiter.check('probe.burst', subject, 4);
    expect([first.allowed, second.allowed, third.allowed]).toEqual([
      true,
      true,
      false,
    ]);
    expect([first.remaining, second.remaining, third.remaining]).toEqual([
      6, 2, 2,
    ]);
    expect((await a.limiter.check('probe.burst', subject, 2)).allowed).toBe(
      true,
    );
  });

  it('S50 AS-06: a cost above the limit is a permanent denial that changes nothing', async () => {
    const subject = uniqueSubject();
    await a.limiter.check('probe.burst', subject, 3);
    const before = await a.redis.client.hgetall(
      `rl:{probe.burst|${subject}}:tb`,
    );
    const d = await a.limiter.check('probe.burst', subject, 11);
    expect(d).toMatchObject({
      allowed: false,
      reason: 'cost-exceeds-limit',
      retryAfterMs: null,
    });
    expect(
      await a.redis.client.hgetall(`rl:{probe.burst|${subject}}:tb`),
    ).toEqual(before);
    // a cost equal to the limit still fits a full bucket
    expect(
      (await a.limiter.check('probe.burst', uniqueSubject(), 10)).allowed,
    ).toBe(true);
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    'S50 AS-07: cost %p throws and changes nothing',
    async (cost) => {
      const subject = uniqueSubject();
      await expect(
        a.limiter.check('probe.burst', subject, cost),
      ).rejects.toBeInstanceOf(InvalidRateLimitCostError);
      expect(await storedItems(a.redis, subject)).toEqual([]);
    },
  );

  it('S50 AS-08: the stored state expires within time-to-full plus one second; nothing is left without an expiry', async () => {
    const subject = uniqueSubject();
    await a.limiter.check('probe.burst', subject);
    const items = await storedItems(a.redis, subject);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe(`rl:{probe.burst|${subject}}:tb`);
    // time-to-full of a 10 per minute bucket is 60 s
    expect(items[0].ttlMs).toBeGreaterThan(0);
    expect(items[0].ttlMs).toBeLessThanOrEqual(61_000);
  });

  it('S50 AS-83: lowering the policy clamps the stored tokens; raising it refills from the current level', async () => {
    const subject = uniqueSubject();
    const policyName = 'probe.resize' as const;
    // the same policy name with another shape: what a later deployment of the same owner declares
    const at = (limit: number) =>
      createLimiter({
        time: a.manualTime,
        probe: false,
        policies: [
          definePolicies('rate-limit-test', {
            [policyName]: {
              algorithm: 'tokenBucket',
              limit,
              windowMs: 60_000,
              key: 'user',
              failMode: 'closed',
            },
          }),
        ],
      });
    const v100 = await at(100);
    const v10 = await at(10);
    const v50 = await at(50);
    try {
      a.manualTime.set(T0);
      // 100 tokens stored: one decision under burst 100 leaves 99
      expect((await v100.limiter.check(policyName, subject)).remaining).toBe(
        99,
      );
      // lowered to burst 10: at most 10 tokens seen
      const lowered = await v10.limiter.check(policyName, subject);
      expect(lowered.allowed).toBe(true);
      expect(lowered.remaining).toBeLessThanOrEqual(9);
      // raised to 50: no jump to 50 — the bucket continues from its current level
      const raised = await v50.limiter.check(policyName, subject);
      expect(raised.allowed).toBe(true);
      expect(raised.remaining).toBeLessThan(10);
    } finally {
      await v100.close();
      await v10.close();
      await v50.close();
    }
  });
});
