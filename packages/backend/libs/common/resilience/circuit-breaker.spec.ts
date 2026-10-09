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
