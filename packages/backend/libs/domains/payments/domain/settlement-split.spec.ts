import * as fc from 'fast-check';
import { splitSettlement } from './settlement-split';
import {
  SETTLEMENT_ATTEMPTS,
  SETTLEMENT_RETRY_DELAYS_MS,
  nextSettlementStep,
} from './settlement-retry';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Settlement split (shop share = lines less commission, commission to the platform)', () => {
  it('S14 AS-17: two shops, lines at 10 %: each shop gets its lines less commission and the platform the rest', () => {
    const split = splitSettlement([
      { shopId: id(1), lineTotalMinor: 2000, commissionMinor: 200 },
      { shopId: id(2), lineTotalMinor: 500, commissionMinor: 50 },
    ]);
    expect(split.shares).toEqual([
      { shopId: id(1), shareMinor: 1800 },
      { shopId: id(2), shareMinor: 450 },
    ]);
    expect(split.commissionMinor).toBe(250);
  });

  it('S14 AS-17: lines of one shop add up before the share is taken, and the order of the input does not matter', () => {
    const lines = [
      { shopId: id(2), lineTotalMinor: 1005, commissionMinor: 70 },
      { shopId: id(1), lineTotalMinor: 100, commissionMinor: 10 },
      { shopId: id(2), lineTotalMinor: 1005, commissionMinor: 101 },
    ];
    const split = splitSettlement(lines);
    expect(split.shares).toEqual([
      { shopId: id(1), shareMinor: 90 },
      { shopId: id(2), shareMinor: 1839 },
    ]);
    expect(split.commissionMinor).toBe(181);
    expect(splitSettlement([...lines].reverse())).toEqual(split);
  });

  it('S14 AS-17: a shop whose lines carry no money gets no share line, a zero commission gives zero', () => {
    const split = splitSettlement([
      { shopId: id(1), lineTotalMinor: 0, commissionMinor: 0 },
      { shopId: id(2), lineTotalMinor: 300, commissionMinor: 0 },
    ]);
    expect(split.shares).toEqual([
      { shopId: id(1), shareMinor: 0 },
      { shopId: id(2), shareMinor: 300 },
    ]);
    expect(split.commissionMinor).toBe(0);
  });

  it.each([
    [{ lineTotalMinor: -1, commissionMinor: 0 }],
    [{ lineTotalMinor: 10, commissionMinor: 11 }],
    [{ lineTotalMinor: 10, commissionMinor: -1 }],
    [{ lineTotalMinor: 1.5, commissionMinor: 0 }],
  ])('S14 AS-17: refuses the malformed line %j', (line) => {
    expect(() => splitSettlement([{ shopId: id(1), ...line }])).toThrow(
      RangeError,
    );
  });

  it('S14 AS-17: refuses an order without lines', () => {
    expect(() => splitSettlement([])).toThrow(RangeError);
  });

  it('S14 AS-17: shares and commission always add up to the lines, none is negative (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .record({
              n: fc.integer({ min: 1, max: 5 }),
              total: fc.integer({ min: 0, max: 99_999_999 }),
              bps: fc.integer({ min: 0, max: 10_000 }),
            })
            .map((r) => ({
              shopId: id(r.n),
              lineTotalMinor: r.total,
              commissionMinor: Math.floor((r.total * r.bps) / 10_000),
            })),
          { minLength: 1, maxLength: 30 },
        ),
        (lines) => {
          const split = splitSettlement(lines);
          const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
          return (
            sum(split.shares.map((s) => s.shareMinor)) +
              split.commissionMinor ===
              sum(lines.map((l) => l.lineTotalMinor)) &&
            split.shares.every((s) => s.shareMinor >= 0)
          );
        },
      ),
    );
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
