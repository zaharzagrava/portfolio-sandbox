import {
  BACKOFF_BASE_S,
  BACKOFF_CAP_S,
  MAX_DELIVERY_ATTEMPTS,
  backoffSeconds,
} from './backoff';

/** A seeded source: the same seed gives the same sequence (mulberry32). */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('S28 AS-48: delivery retry backoff (pure)', () => {
  it('the constants of the rule: base 30 s, cap 15 minutes, 5 attempts', () => {
    expect(BACKOFF_BASE_S).toBe(30);
    expect(BACKOFF_CAP_S).toBe(900);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(5);
  });

  it.each([
    [1, 30],
    [2, 60],
    [3, 120],
    [4, 240],
    [5, 480],
    [6, 900],
    [9, 900],
  ])(
    'attempt %i: full jitter lies in [0, %i] for every random value',
    (attempt, ceiling) => {
      expect(backoffSeconds(attempt, () => 0)).toBe(0);
      expect(backoffSeconds(attempt, () => 0.5)).toBe(ceiling / 2);
      expect(backoffSeconds(attempt, () => 0.999999)).toBeLessThanOrEqual(
        ceiling,
      );
      const random = seeded(attempt);
      for (let i = 0; i < 200; i++) {
        const delay = backoffSeconds(attempt, random);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    },
  );

  it('is deterministic for the same seed and never exceeds 900 s, however large the attempt', () => {
    for (let attempt = 1; attempt <= 40; attempt++) {
      const a = backoffSeconds(attempt, seeded(42));
      expect(backoffSeconds(attempt, seeded(42))).toBe(a);
      expect(a).toBeLessThanOrEqual(900);
    }
    expect(backoffSeconds(1, seeded(1))).not.toBe(backoffSeconds(1, seeded(2)));
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'an attempt number that is not a positive integer (%s) is refused',
    (attempt) => {
      expect(() => backoffSeconds(attempt, () => 0.5)).toThrow(/attempt/);
    },
  );
});
