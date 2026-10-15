import { jobRetryDelayMs, resolverDelayMs } from './payout-backoff';

const MIN = 60_000;

describe('resolver backoff (S15 AS-20)', () => {
  it.each([
    [0, 1 * MIN],
    [1, 2 * MIN],
    [2, 4 * MIN],
    [3, 8 * MIN],
    [4, 15 * MIN],
    [5, 15 * MIN],
    [50, 15 * MIN],
  ])(
    'S15 AS-20: after %i unreachable lookups the ceiling is %i ms',
    (n, cap) => {
      expect(resolverDelayMs(n, () => 0.999999)).toBeLessThanOrEqual(cap);
      expect(resolverDelayMs(n, () => 0.999999)).toBeGreaterThan(cap - 10);
    },
  );

  it('S15 AS-20: full jitter spans [0, ceiling]', () => {
    expect(resolverDelayMs(2, () => 0)).toBe(0);
    expect(resolverDelayMs(2, () => 0.5)).toBe(2 * MIN);
    for (let i = 0; i < 200; i += 1) {
      const delay = resolverDelayMs(3, Math.random);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(8 * MIN);
    }
  });

  it('S15 AS-20: a negative or non-integer count is treated as the first', () => {
    expect(resolverDelayMs(-3, () => 0.5)).toBe(MIN / 2);
    expect(resolverDelayMs(Number.NaN, () => 0.5)).toBe(MIN / 2);
  });
});

describe('job retry delay (S15 AS-24)', () => {
  it.each([
    [1, 5_000],
    [2, 10_000],
    [3, 20_000],
    [4, 40_000],
    [5, 80_000],
    [20, 300_000],
  ])('S15 AS-24: attempt %i has a ceiling of %i ms', (attempt, cap) => {
    expect(jobRetryDelayMs(attempt, () => 0.999999)).toBeLessThanOrEqual(cap);
    expect(jobRetryDelayMs(attempt, () => 0.999999)).toBeGreaterThan(cap - 10);
    expect(jobRetryDelayMs(attempt, () => 0)).toBe(0);
  });
});
