import fc from 'fast-check';
import { cosineScore, roundScore } from './cosine-score';

/** Dataset D of spec.md: co-orders and per-product basket counts. */
const N = { P: 86, M: 13, C: 45, K: 43, S: 5 } as const;

describe('cosine score', () => {
  it.each([
    ['P', 'K', 40, 0.6578],
    ['P', 'C', 40, 0.643],
    ['M', 'C', 5, 0.2067],
    ['K', 'S', 3, 0.2046],
    ['P', 'M', 6, 0.1794],
  ] as const)(
    'S34 AS-22: dataset D pair %s-%s with %i co-orders scores %f',
    (a, b, co, expected) => {
      expect(roundScore(cosineScore(co, N[a], N[b]))).toBe(expected);
    },
  );

  it('S34 AS-22: rounding to 4 decimals happens only in roundScore', () => {
    const raw = cosineScore(5, 13, 45);
    expect(raw).not.toBe(roundScore(raw));
    expect(roundScore(0.20674)).toBe(0.2067);
    expect(roundScore(0.20675)).toBe(0.2068);
  });

  it('S34 AS-22: property - symmetric, in (0, 1], and 1 only for identical baskets', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 500 }),
        (co, extraA, extraB) => {
          const na = co + extraA;
          const nb = co + extraB;
          const score = cosineScore(co, na, nb);
          expect(score).toBe(cosineScore(co, nb, na));
          expect(score).toBeGreaterThan(0);
          expect(score).toBeLessThanOrEqual(1);
          if (extraA > 0 || extraB > 0) expect(score).toBeLessThan(1);
          else expect(score).toBe(1);
        },
      ),
    );
  });
});
