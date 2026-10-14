import * as fc from 'fast-check';
import { planDraw, splitUnits } from './flash-bucket-plan';

describe('S11 AS-44: flash bucket plan', () => {
  describe('splitUnits', () => {
    it.each([
      [2000, 16, [...Array(16).fill(125)]],
      [3000, 16, [...Array(8).fill(188), ...Array(8).fill(187)]],
      [10, 3, [4, 3, 3]],
      [1, 4, [1, 0, 0, 0]],
      [5, 1, [5]],
      [0, 3, [0, 0, 0]],
    ])('S11 AS-44: %i units over %i buckets', (units, buckets, expected) => {
      expect(splitUnits(units, buckets)).toEqual(expected);
    });

    it('S11 AS-44: parts sum to the units, differ by at most one, larger first', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 1_000_000 }),
          fc.integer({ min: 1, max: 256 }),
          (units, buckets) => {
            const parts = splitUnits(units, buckets);
            expect(parts).toHaveLength(buckets);
            expect(parts.reduce((a, b) => a + b, 0)).toBe(units);
            expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(
              1,
            );
            for (let i = 1; i < parts.length; i++)
              expect(parts[i - 1]).toBeGreaterThanOrEqual(parts[i]);
          },
        ),
      );
    });
  });

  describe('planDraw', () => {
    it.each([
      ['one bucket suffices', [5, 5], 2, 0, [{ bucket: 0, take: 2 }]],
      ['start bucket rotates the order', [5, 5], 2, 1, [{ bucket: 1, take: 2 }]],
      [
        'combines two buckets (1+1, q=2)',
        [1, 1],
        2,
        0,
        [
          { bucket: 0, take: 1 },
          { bucket: 1, take: 1 },
        ],
      ],
      [
        'skips empty buckets',
        [0, 1, 0, 1],
        2,
        0,
        [
          { bucket: 1, take: 1 },
          { bucket: 3, take: 1 },
        ],
      ],
      [
        'wraps around from the start bucket',
        [1, 0, 1],
        2,
        2,
        [
          { bucket: 2, take: 1 },
          { bucket: 0, take: 1 },
        ],
      ],
      ['negative bucket counts as empty', [-3, 2], 2, 0, [{ bucket: 1, take: 2 }]],
    ])('S11 AS-44: %s', (_name, contents, q, start, draws) => {
      expect(planDraw(contents, q, start)).toEqual({ kind: 'ok', draws });
    });

    it.each([
      ['1+0 for q=2', [1, 0], 2, 1],
      ['all empty', [0, 0, 0], 1, 0],
      ['negative only', [-1, -5], 1, 0],
    ])('S11 AS-44: insufficient when %s', (_name, contents, q, available) => {
      expect(planDraw(contents, q, 0)).toEqual({ kind: 'insufficient', available });
    });

    it('S11 AS-44: all-or-nothing, never negative or above available; start bucket changes order only', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: -3, max: 50 }), {
            minLength: 1,
            maxLength: 32,
          }),
          fc.integer({ min: 1, max: 20 }),
          fc.nat(40),
          (contents, q, startRaw) => {
            const start = startRaw % contents.length;
            const available = contents.reduce((s, c) => s + Math.max(0, c), 0);
            const plan = planDraw(contents, q, start);
            if (available < q) {
              expect(plan).toEqual({ kind: 'insufficient', available });
              return;
            }
            expect(plan.kind).toBe('ok');
            if (plan.kind !== 'ok') return;
            expect(plan.draws.reduce((s, d) => s + d.take, 0)).toBe(q);
            for (const d of plan.draws) {
              expect(d.take).toBeGreaterThan(0);
              expect(d.take).toBeLessThanOrEqual(Math.max(0, contents[d.bucket]));
            }
            expect(new Set(plan.draws.map((d) => d.bucket)).size).toBe(
              plan.draws.length,
            );
            // success does not depend on the start bucket
            expect(planDraw(contents, q, 0).kind).toBe('ok');
          },
        ),
      );
    });
  });
});
