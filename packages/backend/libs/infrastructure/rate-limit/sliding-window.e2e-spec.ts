import { FakeClock } from '@app/common/core/clock';
import { inParallel } from '@app/test/utils/async-helpers';
import type { RateLimitDecision } from './rate-limit.types';
import {
  LimiterInstance,
  T0,
  createLimiter,
  storedItems,
  uniqueSubject,
} from './test/limiter-fixture';

/** S50 US2: sliding window counter on the store clock, against the real test Redis. */
describe('S50 sliding window (e2e, real Redis)', () => {
  let a: LimiterInstance;

  beforeAll(async () => {
    a = await createLimiter();
  });

  afterAll(async () => {
    await a.close();
  });

  beforeEach(() => a.manualTime.set(T0));

  const decide = (
    policy: 'probe.window5' | 'probe.window100' | 'probe.window10',
    subject: string,
  ) => a.limiter.check(policy, subject);

  it('S50 AS-09: 5 per 15 minutes — the sixth attempt is denied, with a wait', async () => {
    const subject = uniqueSubject('email');
    const decisions: RateLimitDecision[] = [];
    for (let i = 0; i < 6; i++)
      decisions.push(await decide('probe.window5', subject));
    expect(decisions.map((d) => d.allowed)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(decisions.map((d) => d.remaining)).toEqual([4, 3, 2, 1, 0, 0]);
    expect(decisions[5]).toMatchObject({
      reason: 'limit-exceeded',
      source: 'store',
    });
    expect(decisions[5].retryAfterMs).toBeGreaterThan(0);
  });

  it('S50 AS-10: 200 parallel checks against a limit of 100 → exactly 100 allowed', async () => {
    const subject = uniqueSubject();
    const results = await inParallel(200, () =>
      decide('probe.window100', subject),
    );
    const allowed = results.filter(
      (r) => r.status === 'fulfilled' && r.value.allowed,
    );
    expect(allowed).toHaveLength(100);
  });

  it('S50 AS-11: right after a window boundary nothing is admitted beyond the weighted estimate', async () => {
    const subject = uniqueSubject();
    // fill the 10-per-10-seconds window, then cross into the next one
    for (let i = 0; i < 10; i++)
      expect((await decide('probe.window10', subject)).allowed).toBe(true);
    a.manualTime.set(T0 + 10_000); // first instant of the next window: previous weighs 100%
    expect((await decide('probe.window10', subject)).allowed).toBe(false);
    a.manualTime.set(T0 + 10_999); // 999 ms in: previous weighs 90.01% → estimate 9.001, no room
    expect((await decide('probe.window10', subject)).allowed).toBe(false);
    a.manualTime.set(T0 + 11_000); // 1 s in: previous weighs 90% → estimate 9 → exactly one fits
    expect((await decide('probe.window10', subject)).allowed).toBe(true);
    expect((await decide('probe.window10', subject)).allowed).toBe(false);
  });

  it('S50 AS-12: halfway through the next window the previous one weighs 50% → 5 admitted', async () => {
    const subject = uniqueSubject();
    for (let i = 0; i < 10; i++) await decide('probe.window10', subject);
    a.manualTime.set(T0 + 15_000);
    const results: boolean[] = [];
    for (let i = 0; i < 7; i++)
      results.push((await decide('probe.window10', subject)).allowed);
    expect(results).toEqual([true, true, true, true, true, false, false]);
  });

  it.each([
    ['current window full', 10, 3_000, 0],
    ['previous window full, start of next window', 10, 10_000, 0],
    ['previous window half full, start of next window', 5, 10_000, 0],
  ])(
    'S50 AS-13: retryAfterMs is exact — %s: admitted after R, denied after R-1',
    async (_label, fill, denyAtOffset, _unused) => {
      const prepare = async (): Promise<string> => {
        const subject = uniqueSubject();
        a.manualTime.set(T0);
        if (denyAtOffset === 3_000) {
          for (let i = 0; i < fill; i++)
            await decide('probe.window10', subject);
        } else {
          for (let i = 0; i < fill; i++)
            await decide('probe.window10', subject);
          // top the half-full case up inside the next window so the request is denied there
          a.manualTime.set(T0 + denyAtOffset);
          if (fill < 10)
            for (let i = 0; i < 10 - fill; i++)
              await decide('probe.window10', subject);
        }
        a.manualTime.set(T0 + denyAtOffset);
        return subject;
      };

      const probe = await prepare();
      const denied = await decide('probe.window10', probe);
      expect(denied.allowed).toBe(false);
      const wait = denied.retryAfterMs as number;
      expect(wait).toBeGreaterThanOrEqual(1);

      const exact = await prepare();
      a.manualTime.set(T0 + denyAtOffset + wait);
      expect((await decide('probe.window10', exact)).allowed).toBe(true);

      const early = await prepare();
      a.manualTime.set(T0 + denyAtOffset + wait - 1);
      expect((await decide('probe.window10', early)).allowed).toBe(false);
    },
  );

  it('S50 AS-14: two instances with application clocks an hour apart share one budget on the store clock', async () => {
    const early = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    const late = new FakeClock(new Date('2026-01-01T01:00:00Z'));
    const one = await createLimiter({ time: 'store', clock: early });
    const two = await createLimiter({ time: 'store', clock: late });
    try {
      const subject = uniqueSubject();
      const results = await inParallel(120, (i) =>
        (i % 2 ? one : two).limiter.check('probe.window100', subject),
      );
      const allowed = results.filter(
        (r) => r.status === 'fulfilled' && r.value.allowed,
      );
      expect(allowed).toHaveLength(100);
      // every stored counter expires within two windows
      const items = await storedItems(one.redis, subject);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.ttlMs).toBeGreaterThan(0);
        expect(item.ttlMs).toBeLessThanOrEqual(2 * 60_000);
      }
    } finally {
      await one.close();
      await two.close();
    }
  });

  it('S50 AS-73: both window items of a decision share one hash tag', async () => {
    const subject = uniqueSubject();
    await decide('probe.window10', subject);
    a.manualTime.set(T0 + 10_000);
    await decide('probe.window10', subject);
    const keys = (await storedItems(a.redis, subject)).map((i) => i.key).sort();
    expect(keys).toHaveLength(2);
    for (const key of keys)
      expect(key.startsWith(`rl:{probe.window10|${subject}}:sw:`)).toBe(true);
  });
});
