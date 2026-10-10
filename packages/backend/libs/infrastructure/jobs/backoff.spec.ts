import { retryCeilingMs, retryDelayMs } from './backoff';

describe('job retry backoff (S49)', () => {
  it.each([
    [0, 1_000],
    [1, 2_000],
    [2, 4_000],
    [3, 8_000],
    [4, 16_000],
    [9, 512_000],
    [10, 900_000],
    [11, 900_000],
    [50, 900_000],
  ])('S49 AS-18: attempts %i -> ceiling %i ms', (attempts, ceiling) => {
    expect(retryCeilingMs(attempts)).toBe(ceiling);
  });

  it.each([0, 1, 3, 10, 30])(
    'S49 AS-18: jitter after %i attempts stays inside 0..ceiling',
    (attempts) => {
      const ceiling = retryCeilingMs(attempts);
      expect(retryDelayMs(attempts, () => 0)).toBe(0);
      expect(retryDelayMs(attempts, () => 0.5)).toBe(Math.floor(ceiling / 2));
      expect(retryDelayMs(attempts, () => 0.999999)).toBeLessThan(ceiling);
      for (let i = 0; i < 50; i++) {
        const d = retryDelayMs(attempts);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(ceiling);
      }
    },
  );
});
