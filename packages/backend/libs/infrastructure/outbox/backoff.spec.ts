import fc from 'fast-check';
import { relayBackoffMs, RELAY_BACKOFF } from './relay-backoff';

describe('S53 relay backoff', () => {
  it('S53 AS-14: the window is 1 s base, 60 s cap', () => {
    expect(RELAY_BACKOFF).toEqual({ baseMs: 1_000, maxMs: 60_000 });
  });

  it.each([
    [1, 2_000],
    [2, 4_000],
    [3, 8_000],
    [5, 32_000],
    [6, 60_000],
    [10, 60_000],
    [60, 60_000],
  ])(
    'S53 AS-14: after %s failed attempts the ceiling is %s ms',
    (attempts, ceiling) => {
      expect(relayBackoffMs(attempts, () => 0)).toBe(0);
      expect(relayBackoffMs(attempts, () => 0.999999)).toBe(ceiling - 1);
      expect(relayBackoffMs(attempts, () => 0.5)).toBe(ceiling / 2);
    },
  );

  it('S53 AS-14: any scripted random lands inside [0, min(60 s, 1 s x 2^attempts)]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        (attempts, r) => {
          const delay = relayBackoffMs(attempts, () => r);
          const ceiling = Math.min(60_000, 1_000 * 2 ** attempts);
          return Number.isInteger(delay) && delay >= 0 && delay <= ceiling;
        },
      ),
    );
  });

  it('S53 AS-14: the delay never decreases in its ceiling as attempts grow', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        (attempts, r) =>
          relayBackoffMs(attempts + 1, () => r) >=
          relayBackoffMs(attempts, () => r),
      ),
    );
  });
});
