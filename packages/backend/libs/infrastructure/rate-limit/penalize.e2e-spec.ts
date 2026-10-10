import { FakeClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import {
  InvalidPenaltyError,
  UnsupportedPenaltyError,
} from './rate-limit.errors';
import {
  LimiterInstance,
  T0,
  createLimiter,
  proxyUrl,
  startStoreProxy,
  uniqueSubject,
} from './test/limiter-fixture';

/** S50 US9: a provider's "slow down" honoured by every worker. Real Redis, two instances, injected store time. */
describe('S50 penalize (e2e, real Redis)', () => {
  let one: LimiterInstance;
  let two: LimiterInstance;
  let clockTwo: FakeClock;

  beforeEach(async () => {
    one = await createLimiter({ clock: new FakeClock() });
    clockTwo = new FakeClock();
    two = await createLimiter({ clock: clockTwo });
  });

  afterEach(async () => {
    await one.close();
    await two.close();
  });

  const setTime = (ms: number) => {
    one.manualTime.set(ms);
    two.manualTime.set(ms);
  };
  const advance = (ms: number) => {
    one.manualTime.advance(ms);
    two.manualTime.advance(ms);
  };

  it('S50 AS-60: a penalty on one instance pauses the subject on every instance; other subjects are unaffected', async () => {
    const subject = uniqueSubject();
    const other = uniqueSubject();
    expect(await one.limiter.penalize('probe.burst', subject, 30_000)).toBe(
      true,
    );
    const d = await two.limiter.check('probe.burst', subject);
    expect(d).toMatchObject({ allowed: false, reason: 'paused' });
    expect(Math.abs((d.retryAfterMs as number) - 30_000)).toBeLessThanOrEqual(
      50,
    );
    expect((await two.limiter.check('probe.burst', other)).allowed).toBe(true);
    expect(
      MetricsRegistry.value('rate_limit_penalties_total', {
        policy: 'probe.burst',
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('S50 AS-61: a penalty never shortens a pause, extends it, is capped, and rejects invalid values', async () => {
    const subject = uniqueSubject();
    await one.limiter.penalize('probe.burst', subject, 20_000);
    await one.limiter.penalize('probe.burst', subject, 5_000);
    expect((await two.limiter.check('probe.burst', subject)).retryAfterMs).toBe(
      20_000,
    );
    await one.limiter.penalize('probe.burst', subject, 40_000);
    expect((await two.limiter.check('probe.burst', subject)).retryAfterMs).toBe(
      40_000,
    );

    const capped = uniqueSubject();
    await one.limiter.penalize('probe.burst', capped, 2 * 3_600_000);
    expect((await two.limiter.check('probe.burst', capped)).retryAfterMs).toBe(
      3_600_000,
    );

    for (const bad of [0, -5, NaN, Infinity, -Infinity])
      await expect(
        one.limiter.penalize('probe.burst', uniqueSubject(), bad),
      ).rejects.toBeInstanceOf(InvalidPenaltyError);
  });

  it('S50 AS-62: penalize is best effort — false when the store is down, never a throw', async () => {
    const proxy: TcpFaultProxy = await startStoreProxy();
    const inst = await createLimiter({
      clientUrl: proxyUrl(proxy),
      clock: new FakeClock(),
    });
    try {
      expect(
        await inst.limiter.penalize('probe.burst', uniqueSubject(), 1_000),
      ).toBe(true);
      proxy.mode = 'refuse';
      proxy.sever();
      await expect(
        inst.limiter.penalize('probe.burst', uniqueSubject(), 1_000),
      ).resolves.toBe(false);
    } finally {
      await inst.close();
      await proxy.close();
    }
  });

  it('S50 AS-63: other algorithms cannot be penalized and nothing changes', async () => {
    const subject = uniqueSubject();
    await expect(
      one.limiter.penalize('probe.window10', subject, 1_000),
    ).rejects.toBeInstanceOf(UnsupportedPenaltyError);
    await expect(
      one.limiter.penalize('probe.conc2', subject, 1_000),
    ).rejects.toBeInstanceOf(UnsupportedPenaltyError);
    expect(await one.redis.client.keys(`rl:*${subject}*`)).toEqual([]);
  });

  it('S50 AS-64: the penalizing instance drops its lease at once; another instance stops within the lease lifetime', async () => {
    const subject = uniqueSubject();
    // both hold a lease (slice of 6, one spent)
    expect((await one.limiter.check('probe.hot', subject)).allowed).toBe(true);
    expect((await two.limiter.check('probe.hot', subject)).allowed).toBe(true);

    await one.limiter.penalize('probe.hot', subject, 30_000);
    const mine = await one.limiter.check('probe.hot', subject);
    expect(mine).toMatchObject({ allowed: false, reason: 'paused' });

    // the other instance spends at most its unspent slice, then stops once the lease ends
    let admitted = 0;
    for (let i = 0; i < 10; i++)
      if ((await two.limiter.check('probe.hot', subject)).allowed) admitted++;
    expect(admitted).toBeLessThanOrEqual(5);
    clockTwo.advance(1_001);
    expect(await two.limiter.check('probe.hot', subject)).toMatchObject({
      allowed: false,
      reason: 'paused',
    });
  });

  it('S50 AS-65: no burst after a pause — nothing at the instant it ends, one token after one refill interval', async () => {
    const subject = uniqueSubject();
    setTime(T0);
    await one.limiter.penalize('probe.burst', subject, 30_000);
    setTime(T0 + 30_000); // the pause has just ended
    const parallel = await Promise.all(
      Array.from({ length: 10 }, () =>
        two.limiter.check('probe.burst', subject),
      ),
    );
    expect(parallel.filter((d) => d.allowed)).toHaveLength(0);
    advance(6_000); // one refill interval of a 10-per-minute bucket
    const later = await Promise.all(
      Array.from({ length: 10 }, () =>
        two.limiter.check('probe.burst', subject),
      ),
    );
    expect(later.filter((d) => d.allowed)).toHaveLength(1);
  });
});
