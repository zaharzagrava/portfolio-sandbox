import * as fc from 'fast-check';
import { splitSettlement } from './settlement-split';
import {
  SETTLEMENT_ATTEMPTS,
  SETTLEMENT_RETRY_DELAYS_MS,
  nextSettlementStep,
} from './settlement-retry';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Settlement split (largest remainder, ties to the lowest shop id)', () => {
  it.each([
    [1000, [1, 1, 1], [334, 333, 333]],
    [2450, [1500, 1000], [1470, 980]],
    [100, [1, 1, 1], [34, 33, 33]],
    [5, [1, 1], [3, 2]],
    [1, [1, 1, 1], [1, 0, 0]],
    [0, [5, 5], [0, 0]],
    [7, [0, 7], [0, 7]],
    [99_999_999, [3, 3, 3], [33_333_333, 33_333_333, 33_333_333]],
  ])(
    'S14 AS-17: net %d over subtotals %j gives %j',
    (net, subtotals, expected) => {
      const shops = subtotals.map((s, i) => ({
        shopId: id(i + 1),
        subtotalMinor: s,
      }));
      expect(splitSettlement(net, shops).map((s) => s.shareMinor)).toEqual(
        expected,
      );
    },
  );

  it('S14 AS-17: ties go to the lowest shop id whatever the input order', () => {
    const shops = [
      { shopId: id(3), subtotalMinor: 1 },
      { shopId: id(1), subtotalMinor: 1 },
      { shopId: id(2), subtotalMinor: 1 },
    ];
    expect(splitSettlement(1000, shops)).toEqual([
      { shopId: id(1), shareMinor: 334 },
      { shopId: id(2), shareMinor: 333 },
      { shopId: id(3), shareMinor: 333 },
    ]);
  });

  it('S14 AS-17: is exact beyond 2^53 intermediate products', () => {
    const shops = [
      { shopId: id(1), subtotalMinor: 99_999_999 },
      { shopId: id(2), subtotalMinor: 99_999_998 },
    ];
    const shares = splitSettlement(99_999_999, shops).map((s) => s.shareMinor);
    expect(shares[0] + shares[1]).toBe(99_999_999);
  });

  it('S14 AS-17: shares sum to the net, are never negative and ignore input order (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99_999_999 }),
        fc.uniqueArray(
          fc.record({
            n: fc.integer({ min: 1, max: 1_000_000 }),
            subtotalMinor: fc.integer({ min: 0, max: 99_999_999 }),
          }),
          { minLength: 1, maxLength: 30, selector: (r) => r.n },
        ),
        (net, rows) => {
          fc.pre(rows.some((r) => r.subtotalMinor > 0));
          const shops = rows.map((r) => ({
            shopId: id(r.n),
            subtotalMinor: r.subtotalMinor,
          }));
          const a = splitSettlement(net, shops);
          const b = splitSettlement(net, [...shops].reverse());
          return (
            a.reduce((s, x) => s + x.shareMinor, 0) === net &&
            a.every((x) => x.shareMinor >= 0) &&
            JSON.stringify(a) === JSON.stringify(b)
          );
        },
      ),
    );
  });

  it('S14 AS-17: refuses subtotals that sum to zero', () => {
    expect(() =>
      splitSettlement(10, [
        { shopId: id(1), subtotalMinor: 0 },
        { shopId: id(2), subtotalMinor: 0 },
      ]),
    ).toThrow();
  });
});

describe('Settlement retry schedule', () => {
  it('S14 AS-20: six attempts, five waits, about ten minutes in total', () => {
    expect(SETTLEMENT_ATTEMPTS).toBe(6);
    expect(SETTLEMENT_RETRY_DELAYS_MS).toHaveLength(5);
    const total = SETTLEMENT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBe(600_000);
  });

  it('S14 AS-20: the waits never shrink and each stays within 30 s to 3.5 minutes', () => {
    for (let i = 0; i < SETTLEMENT_RETRY_DELAYS_MS.length; i++) {
      expect(SETTLEMENT_RETRY_DELAYS_MS[i]).toBeGreaterThanOrEqual(30_000);
      expect(SETTLEMENT_RETRY_DELAYS_MS[i]).toBeLessThanOrEqual(210_000);
      if (i > 0)
        expect(SETTLEMENT_RETRY_DELAYS_MS[i]).toBeGreaterThanOrEqual(
          SETTLEMENT_RETRY_DELAYS_MS[i - 1],
        );
    }
  });

  it.each([
    [1, 30_000],
    [2, 60_000],
    [3, 120_000],
    [4, 180_000],
    [5, 210_000],
  ])(
    'S14 AS-20: after failed attempt %i the next one runs in %i ms',
    (attempt, delay) => {
      expect(nextSettlementStep(attempt)).toEqual({ delayMs: delay });
    },
  );

  it.each([6, 7, 100])(
    'S14 AS-20: after failed attempt %i there is no next step (dead letter)',
    (attempt) => {
      expect(nextSettlementStep(attempt)).toBeNull();
    },
  );
});
