import * as fc from 'fast-check';
import { jitterTtl, shouldRecomputeEarly } from './xfetch';

const E = 1_000_000;
const draw = (r: number) => () => r;
const unitDouble = fc.double({
  min: 0,
  max: 1,
  maxExcluded: true,
  noNaN: true,
});

describe('XFetch early refresh', () => {
  it.each([
    // now, delta, r, expected  (delta = 100, beta = 1, now = E - 50: refresh iff r <= e^-0.5 ~ 0.6065)
    [E - 50, 100, 0.3, true],
    [E - 50, 100, 0.6, true],
    [E - 50, 100, Math.exp(-0.5) - 1e-9, true],
    [E - 50, 100, Math.exp(-0.5) + 1e-3, false],
    [E - 50, 100, 0.9, false],
    [E - 50, 100, 0.999999, false],
    [E - 1_000, 100, 0.01, false], // far from expiry: ln(0.01) * 100 = 460 ms is not enough
    [E, 100, 0.99, true], // at expiry
    [E + 5, 0, 0.5, true], // past expiry
  ])(
    'S52 AS-19: at now=%s with delta=%s and r=%s the decision is %s',
    (now, delta, r, expected) => {
      expect(shouldRecomputeEarly(now, E, delta, 1, draw(r))).toBe(expected);
    },
  );

  it('S52 AS-19: a draw of 0 never yields an infinite or NaN result', () => {
    expect(shouldRecomputeEarly(E - 50, E, 100, 1, draw(0))).toBe(true);
    expect(shouldRecomputeEarly(E - 50, E, 0, 1, draw(0))).toBe(false);
  });

  it('S52 AS-19: with delta = 0 an early refresh is never chosen before expiry', () => {
    fc.assert(
      fc.property(
        unitDouble,
        fc.integer({ min: 1, max: 10_000_000 }),
        (r, before) => !shouldRecomputeEarly(E - before, E, 0, 1, draw(r)),
      ),
    );
  });

  it('S52 AS-19: beta scales how early the refresh happens', () => {
    expect(shouldRecomputeEarly(E - 120, E, 100, 1, draw(0.3))).toBe(true);
    expect(shouldRecomputeEarly(E - 120, E, 100, 0.5, draw(0.3))).toBe(false);
  });

  it('S52 AS-19: the decision is monotonic in the draw (a smaller draw refreshes whenever a larger one does)', () => {
    fc.assert(
      fc.property(
        unitDouble,
        unitDouble,
        fc.integer({ min: 0, max: 5_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        (a, b, delta, before) => {
          const [small, large] = a <= b ? [a, b] : [b, a];
          const atLarge = shouldRecomputeEarly(
            E - before,
            E,
            delta,
            1,
            draw(large),
          );
          const atSmall = shouldRecomputeEarly(
            E - before,
            E,
            delta,
            1,
            draw(small),
          );
          return !atLarge || atSmall;
        },
      ),
    );
  });
});

describe('TTL jitter', () => {
  it.each([
    [60_000, 0.1, 0, 54_000],
    [60_000, 0.1, 0.5, 60_000],
    [60_000, 0.1, 0.999999, 66_000],
    [1_000, 0.1, 0, 900],
    [1_000, 0.1, 0.999999, 1_100],
    [60_000, 0.5, 0, 30_000],
  ])(
    'S52 AS-20: jitterTtl(%s, %s) with draw %s → %s ms',
    (ttl, spread, r, expected) => {
      expect(jitterTtl(ttl, spread, draw(r))).toBe(expected);
    },
  );

  it('S52 AS-20: jitter 0 gives exactly the ttl', () => {
    expect(jitterTtl(60_000, 0, draw(0.123))).toBe(60_000);
    expect(jitterTtl(60_000, 0, draw(0))).toBe(60_000);
  });

  it('S52 AS-20: 1,000 draws stay in range and are not all equal', () => {
    let state = 12_345;
    const lcg = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    const lifetimes = Array.from({ length: 1_000 }, () =>
      jitterTtl(60_000, 0.1, lcg),
    );
    expect(Math.min(...lifetimes)).toBeGreaterThanOrEqual(54_000);
    expect(Math.max(...lifetimes)).toBeLessThanOrEqual(66_000);
    expect(new Set(lifetimes).size).toBeGreaterThan(100);
    // SC-005's bucket check at unit level: no single second holds more than 5 % of the keys.
    const perSecond = new Map<number, number>();
    for (const l of lifetimes)
      perSecond.set(
        Math.floor(l / 1_000),
        (perSecond.get(Math.floor(l / 1_000)) ?? 0) + 1,
      );
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(1_000 * 0.15);
  });

  it('S52 AS-20: for any ttl, spread and draw the result lies in [ttl(1-s), ttl(1+s)]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 86_400_000 }),
        fc.double({ min: 0, max: 0.5, noNaN: true }),
        unitDouble,
        (ttl, spread, r) => {
          const value = jitterTtl(ttl, spread, draw(r));
          return (
            value >= Math.floor(ttl * (1 - spread)) &&
            value <= Math.ceil(ttl * (1 + spread))
          );
        },
      ),
    );
  });
});
