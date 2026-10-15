import * as fc from 'fast-check';
import { FakeClock } from '@app/common/core/clock';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

const ok = async () => 'ok';
const boom = async () => {
  throw new Error('boom');
};

const build = (
  overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {},
) => {
  const clock = new FakeClock(new Date('2026-03-01T10:00:00.000Z'));
  const breaker = new CircuitBreaker({
    name: `dep-${Math.random()}`,
    clock,
    windowMs: 10_000,
    minimumCalls: 20,
    failureRateThreshold: 0.5,
    openDurationMs: 30_000,
    halfOpenCalls: 3,
    ...overrides,
  });
  return { clock, breaker };
};

/** Runs `failures` failing calls and `successes` passing ones, failures first. */
async function drive(
  breaker: CircuitBreaker,
  failures: number,
  successes: number,
) {
  for (let i = 0; i < failures; i++)
    await breaker.execute(boom).catch(() => undefined);
  for (let i = 0; i < successes; i++) await breaker.execute(ok);
}

describe('CircuitBreaker (U-CB)', () => {
  it('S54 AS-98: 20 calls with 12 failures open the circuit; the next call fails at once with the remaining open time', async () => {
    const { breaker, clock } = build();
    await drive(breaker, 12, 8);
    expect(breaker.state()).toBe('OPEN');
    const calls = jest.fn(ok);
    clock.advance(10_000);
    const error = await breaker.execute(calls).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect((error as CircuitOpenError).retryAfterMs).toBe(20_000);
    expect(calls).not.toHaveBeenCalled();
  });

  it.each([
    ['19 calls, all failing, is below the minimum', 19, 0, 'CLOSED'],
    ['20 calls with 9 failures (45 %) stays closed', 9, 11, 'CLOSED'],
    ['20 calls with 10 failures (50 %) opens', 10, 10, 'OPEN'],
    ['20 calls with 20 failures opens', 20, 0, 'OPEN'],
  ])('S54 AS-98: %s', async (_label, failures, successes, expected) => {
    const { breaker } = build();
    await drive(breaker, failures, successes);
    expect(breaker.state()).toBe(expected);
  });

  it('S54 AS-98: calls older than the window no longer count', async () => {
    const { breaker, clock } = build({ minimumCalls: 4 });
    await drive(breaker, 3, 0);
    clock.advance(10_001);
    await drive(breaker, 1, 0);
    expect(breaker.state()).toBe('CLOSED');
  });

  it('S54 AS-98: after the open duration it is HALF_OPEN with 3 trial calls; 3 successes close it', async () => {
    const { breaker, clock } = build();
    await drive(breaker, 20, 0);
    clock.advance(29_999);
    expect(breaker.state()).toBe('OPEN');
    clock.advance(1);
    expect(breaker.state()).toBe('HALF_OPEN');
    await breaker.execute(ok);
    await breaker.execute(ok);
    expect(breaker.state()).toBe('HALF_OPEN');
    await breaker.execute(ok);
    expect(breaker.state()).toBe('CLOSED');
  });

  it('S54 AS-98: a failed trial reopens the circuit with a fresh timer', async () => {
    const { breaker, clock } = build();
    await drive(breaker, 20, 0);
    clock.advance(30_000);
    await breaker.execute(ok);
    await breaker.execute(boom).catch(() => undefined);
    expect(breaker.state()).toBe('OPEN');
    clock.advance(29_999);
    expect(breaker.state()).toBe('OPEN');
    clock.advance(1);
    expect(breaker.state()).toBe('HALF_OPEN');
  });

  it('S54 AS-99: with all trial slots in flight a further call fails at once', async () => {
    const { breaker, clock } = build();
    await drive(breaker, 20, 0);
    clock.advance(30_000);
    const release: (() => void)[] = [];
    const parked = Array.from({ length: 3 }, () =>
      breaker.execute(
        () =>
          new Promise<string>((resolve) => release.push(() => resolve('late'))),
      ),
    );
    const fourth = await breaker.execute(ok).catch((e: unknown) => e);
    expect(fourth).toBeInstanceOf(CircuitOpenError);
    release.forEach((r) => r());
    await Promise.all(parked);
    expect(breaker.state()).toBe('CLOSED');
  });

  it('S54 AS-100: an open breaker with a fallback returns it flagged degraded without running the call', async () => {
    const { breaker } = build();
    await drive(breaker, 20, 0);
    const call = jest.fn(ok);
    const result = await breaker.execute(call, {
      fallback: async () => 'cached',
    });
    expect(result).toEqual({ value: 'cached', degraded: true });
    expect(call).not.toHaveBeenCalled();
  });

  it('S54 AS-100: a closed breaker returns the call result, not degraded', async () => {
    const { breaker } = build();
    expect(
      await breaker.execute(ok, { fallback: async () => 'cached' }),
    ).toEqual({ value: 'ok', degraded: false });
  });

  it('S54 AS-100: a fallback that throws surfaces its own error unchanged', async () => {
    const { breaker } = build();
    await drive(breaker, 20, 0);
    const failure = new Error('fallback broke');
    await expect(
      breaker.execute(ok, { fallback: async () => Promise.reject(failure) }),
    ).rejects.toBe(failure);
  });

  it('S54 AS-100: without a fallback an open breaker rejects with circuit_open', async () => {
    const { breaker } = build();
    await drive(breaker, 20, 0);
    await expect(breaker.execute(ok)).rejects.toMatchObject({
      kind: 'circuit_open',
    });
  });

  it('S54 AS-101: errors the failure predicate rejects (4xx) never count and never open the breaker', async () => {
    const { breaker } = build({
      minimumCalls: 5,
      isFailure: (e: unknown) => (e as { status?: number }).status !== 404,
    });
    for (let i = 0; i < 30; i++)
      await breaker
        .execute(() =>
          Promise.reject(Object.assign(new Error('nf'), { status: 404 })),
        )
        .catch(() => undefined);
    expect(breaker.state()).toBe('CLOSED');
  });

  it('S54 AS-101: calls slower than the slow-call threshold count as failures', async () => {
    const { breaker, clock } = build({ minimumCalls: 4, slowCallMs: 1_000 });
    for (let i = 0; i < 4; i++) {
      await breaker.execute(async () => {
        clock.advance(1_500);
        return 'slow but fine';
      });
    }
    expect(breaker.state()).toBe('OPEN');
  });

  it('S54 AS-101: breakers are independent per dependency', async () => {
    const a = build();
    const b = build();
    await drive(a.breaker, 20, 0);
    expect(a.breaker.state()).toBe('OPEN');
    expect(b.breaker.state()).toBe('CLOSED');
    await expect(b.breaker.execute(ok)).resolves.toEqual({
      value: 'ok',
      degraded: false,
    });
  });
});

describe('CircuitBreaker consecutiveFailures mode (S46 AS-46)', () => {
  const consecutive = () =>
    build({
      consecutiveFailures: 5,
      minimumCalls: 5,
      failureRateThreshold: 1,
      windowMs: 120_000,
      openDurationMs: 30_000,
      halfOpenCalls: 1,
    });

  it.each([
    ['4 failures stay closed', [false, false, false, false], 'CLOSED'],
    ['5 failures in a row open', [false, false, false, false, false], 'OPEN'],
    [
      'a success resets the run',
      [false, false, false, false, true, false, false, false, false],
      'CLOSED',
    ],
    [
      '5 failures after a reset open',
      [false, false, true, false, false, false, false, false],
      'OPEN',
    ],
  ])('S46 AS-46: %s', async (_name, outcomes, expected) => {
    const { breaker } = consecutive();
    for (const success of outcomes)
      await breaker.execute(success ? ok : boom).catch(() => undefined);
    expect(breaker.state()).toBe(expected);
  });

  it('S46 AS-46: errors that isFailure rejects neither count nor break the run', async () => {
    const { breaker } = build({
      consecutiveFailures: 2,
      isFailure: (e) => !(e instanceof RangeError),
    });
    const aborted = async () => {
      throw new RangeError('aborted');
    };
    await breaker.execute(boom).catch(() => undefined);
    await breaker.execute(aborted).catch(() => undefined);
    expect(breaker.state()).toBe('CLOSED');
    await breaker.execute(boom).catch(() => undefined);
    expect(breaker.state()).toBe('OPEN');
  });

  it('S46 AS-46: open -> half-open after the cooldown; a good probe closes; a failed probe reopens for another cooldown', async () => {
    const { breaker, clock } = consecutive();
    await drive(breaker, 5, 0);
    expect(breaker.state()).toBe('OPEN');
    clock.advance(29_999);
    expect(breaker.state()).toBe('OPEN');
    clock.advance(1);
    expect(breaker.state()).toBe('HALF_OPEN');
    await breaker.execute(ok);
    expect(breaker.state()).toBe('CLOSED');
    // closing clears the run: four more failures stay closed
    await drive(breaker, 4, 0);
    expect(breaker.state()).toBe('CLOSED');
    await drive(breaker, 1, 0);
    expect(breaker.state()).toBe('OPEN');
    clock.advance(30_000);
    await breaker.execute(boom).catch(() => undefined);
    expect(breaker.state()).toBe('OPEN');
    clock.advance(29_999);
    expect(breaker.state()).toBe('OPEN');
    clock.advance(1);
    expect(breaker.state()).toBe('HALF_OPEN');
  });

  it('S46 AS-46: without the option 5 failures do not open the default breaker', async () => {
    const { breaker } = build();
    await drive(breaker, 5, 0);
    expect(breaker.state()).toBe('CLOSED');
  });

  it('S46 AS-46: property - never two concurrent half-open probes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 12 }),
        fc.boolean(),
        async (callers, probeSucceeds) => {
          const { breaker, clock } = consecutive();
          await drive(breaker, 5, 0);
          clock.advance(30_000);
          let inFlight = 0;
          let maxInFlight = 0;
          let started = 0;
          let release!: () => void;
          const gate = new Promise<void>((r) => (release = r));
          const probe = async () => {
            started++;
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await gate;
            inFlight--;
            if (!probeSucceeds) throw new Error('probe failed');
            return 'ok';
          };
          const results = Array.from({ length: callers }, () =>
            breaker.execute(probe).then(
              () => 'ran',
              (e: unknown) =>
                e instanceof CircuitOpenError ? 'refused' : 'failed',
            ),
          );
          await Promise.resolve();
          release();
          const outcomes = await Promise.all(results);
          expect(started).toBe(1);
          expect(maxInFlight).toBe(1);
          expect(outcomes.filter((o) => o === 'refused')).toHaveLength(
            callers - 1,
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});
