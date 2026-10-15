import { retryDelayMs } from './backoff';

const OPTIONS = { baseMs: 500, maxMs: 8_000 };

describe('adapter retry delay', () => {
  it.each([
    // attempt (0-based retry index), random, expected delay = floor(random * min(max, base * 2^attempt))
    [0, 0, 0],
    [0, 0.5, 250],
    [0, 0.999999, 499],
    [1, 0.5, 500],
    [1, 0.999999, 999],
    [2, 0.5, 1_000],
    [4, 0.999999, 7_999],
    [5, 0.5, 4_000], // 500 * 32 = 16 000 capped at 8 000
    [10, 0.999999, 7_999],
  ])(
    'S46 AS-50: retry %i with random %d waits %i ms (full jitter, capped)',
    (attempt, random, expected) => {
      expect(retryDelayMs(attempt, null, OPTIONS, () => random)).toBe(expected);
    },
  );

  it('S46 AS-50: a Retry-After from the provider is waited exactly, with no jitter added', () => {
    expect(retryDelayMs(0, 1_000, OPTIONS, () => 0.9)).toBe(1_000);
    expect(retryDelayMs(1, 0, OPTIONS, () => 0.9)).toBe(0);
    expect(retryDelayMs(1, 30_000, OPTIONS, () => 0.1)).toBe(30_000);
  });

  it('S46 AS-50: 429 without a header (null) uses the jittered default, never NaN or negative', () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const d = retryDelayMs(attempt, null, OPTIONS, Math.random);
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(OPTIONS.maxMs);
    }
  });
});
