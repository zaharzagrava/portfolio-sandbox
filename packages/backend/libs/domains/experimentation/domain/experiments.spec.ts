import fc from 'fast-check';
import { murmur3 } from '@app/common/core/murmur3';
import { bucketOf } from './bucket';
import { assign, assignAll } from './experiments';
import type { RunningExperiment } from './experiment-types';
import { chiSquarePValue, srmCheck } from './stats';

const experiment = (
  patch: Partial<RunningExperiment> = {},
): RunningExperiment => ({
  key: 'ref-exp',
  unit: 'user',
  variants: [
    { key: 'a', weight: 3_400 },
    { key: 'b', weight: 3_300 },
    { key: 'c', weight: 3_300 },
  ],
  layer: 'ref-layer',
  layerFrom: 0,
  layerTo: 10_000,
  ...patch,
});

const unitIds = (n: number, prefix = 'unit') =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

/** First unit id (scanning `probe-N`) for which `bucket(unit)` equals `target`. */
const findUnit = (bucket: (unit: string) => number, target: number): string => {
  for (let i = 0; i < 2_000_000; i++)
    if (bucket(`probe-${i}`) === target) return `probe-${i}`;
  throw new Error(`no unit found for bucket ${target}`);
};

describe('Experiment assignment', () => {
  describe('reference vectors', () => {
    // [unit, layer bucket, variant bucket, variant of the 3,400/3,300/3,300 experiment, in range 5,000-10,000]
    it.each([
      ['user-1', 1242, 8308, 'c', false],
      ['user-2', 7532, 6011, 'b', true],
      ['user-3', 500, 9370, 'c', false],
      ['anon-12345678', 8957, 8388, 'c', true],
      ['visitor-abc12345', 8413, 6395, 'b', true],
      ['00000000-0000-4000-8000-000000000001', 7491, 9483, 'c', true],
      ['x', 6738, 1503, 'a', true],
      ['unit-9999', 9319, 5830, 'b', true],
    ])(
      'S39 AS-17: %s has layer bucket %i, variant bucket %i, variant %s',
      (unit, layerBucket, variantBucket, variant, inRange) => {
        expect(bucketOf('layer:ref-layer', unit)).toBe(layerBucket);
        expect(bucketOf('exp:ref-exp', unit)).toBe(variantBucket);
        expect(assign(experiment(), unit)).toBe(variant);
        expect(assign(experiment({ layerFrom: 5_000 }), unit)).toBe(
          inRange ? variant : null,
        );
        // The salts are namespaced strings of the old hash: the very same values as murmur3 of the joined text.
        expect(layerBucket).toBe(murmur3(`layer:ref-layer:${unit}`) % 10_000);
        expect(variantBucket).toBe(murmur3(`exp:ref-exp:${unit}`) % 10_000);
      },
    );

    it('S39 AS-17: the same unit gets the same variant on 1,000 calls', () => {
      const exp = experiment();
      const first = assign(exp, 'user-77');
      for (let i = 0; i < 1_000; i++)
        expect(assign(exp, 'user-77')).toBe(first);
    });

    it('S39 AS-17: an empty unit is never assigned', () => {
      expect(assign(experiment(), '')).toBeNull();
    });

    it('S39 AS-17: assignment is stable for any unit (property)', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 64 }), (unit) => {
          const exp = experiment();
          expect(assign(exp, unit)).toBe(assign({ ...exp }, unit));
        }),
      );
    });
  });

  describe('distribution', () => {
    it.each([
      ['5,000/5,000', [5_000, 5_000]],
      ['9,000/1,000', [9_000, 1_000]],
      ['3,400/3,300/3,300', [3_400, 3_300, 3_300]],
    ])(
      'S39 AS-18: 100,000 units on %s pass the sample ratio test',
      (_label, weights) => {
        const exp = experiment({
          variants: weights.map((weight, i) => ({ key: `v${i}`, weight })),
        });
        const observed = weights.map(() => 0);
        for (const unit of unitIds(100_000)) {
          const variant = assign(exp, unit);
          observed[Number(variant!.slice(1))] += 1;
        }
        expect(observed.reduce((a, b) => a + b, 0)).toBe(100_000);
        const srm = srmCheck(observed, weights);
        expect(srm.pValue).toBeGreaterThanOrEqual(0.001);
        expect(srm.mismatch).toBe(false);
      },
    );

    it('S39 AS-18: the boundary buckets 0 and 9,999 land in the first and the last variant', () => {
      const exp = experiment();
      const first = findUnit((u) => bucketOf('exp:ref-exp', u), 0);
      const last = findUnit((u) => bucketOf('exp:ref-exp', u), 9_999);
      expect(assign(exp, first)).toBe('a');
      expect(assign(exp, last)).toBe('c');
    });

    it('S39 AS-18: the cumulative edges are exact integers (bucket 3,399 is a, 3,400 is b, 6,699 is b, 6,700 is c)', () => {
      const exp = experiment();
      const at = (bucket: number) =>
        assign(
          exp,
          findUnit((u) => bucketOf('exp:ref-exp', u), bucket),
        );
      expect([at(3_399), at(3_400), at(6_699), at(6_700)]).toEqual([
        'a',
        'b',
        'b',
        'c',
      ]);
    });

    it('S39 AS-18: weights that do not sum to 10,000 are a programming error, not a silent last variant', () => {
      const broken = experiment({
        variants: [
          { key: 'a', weight: 1 },
          { key: 'b', weight: 1 },
        ],
      });
      const unit = findUnit((u) => bucketOf('exp:ref-exp', u), 9_000);
      expect(() => assign(broken, unit)).toThrow(/10,?000/);
    });
  });

  describe('layers', () => {
    it('S39 AS-19: the variants of two experiments in different layers are independent (chi-square test of independence)', () => {
      const x = experiment({
        key: 'exp-x',
        layer: 'layer-x',
        variants: [
          { key: 'x0', weight: 5_000 },
          { key: 'x1', weight: 5_000 },
        ],
      });
      const y = experiment({
        key: 'exp-y',
        layer: 'layer-y',
        variants: [
          { key: 'y0', weight: 5_000 },
          { key: 'y1', weight: 5_000 },
        ],
      });
      const cells = [
        [0, 0],
        [0, 0],
      ];
      const units = unitIds(100_000, 'visitor');
      for (const unit of units)
        cells[assign(x, unit) === 'x0' ? 0 : 1][
          assign(y, unit) === 'y0' ? 0 : 1
        ] += 1;
      const n = units.length;
      const rows = cells.map((row) => row[0] + row[1]);
      const cols = [cells[0][0] + cells[1][0], cells[0][1] + cells[1][1]];
      let chi = 0;
      for (let i = 0; i < 2; i++)
        for (let j = 0; j < 2; j++) {
          const expected = (rows[i] * cols[j]) / n;
          chi += (cells[i][j] - expected) ** 2 / expected;
        }
      expect(chiSquarePValue(chi, 1)).toBeGreaterThanOrEqual(0.001);
    });

    it('S39 AS-19: experiments of one layer with disjoint ranges share no unit, and the range end is exclusive', () => {
      const low = experiment({ key: 'low', layerFrom: 0, layerTo: 5_000 });
      const high = experiment({
        key: 'high',
        layerFrom: 5_000,
        layerTo: 10_000,
      });
      for (const unit of unitIds(20_000))
        expect(assign(low, unit) !== null && assign(high, unit) !== null).toBe(
          false,
        );
      const edgeLow = findUnit((u) => bucketOf('layer:ref-layer', u), 4_999);
      const edgeHigh = findUnit((u) => bucketOf('layer:ref-layer', u), 5_000);
      expect(assign(low, edgeLow)).not.toBeNull();
      expect(assign(high, edgeLow)).toBeNull();
      expect(assign(low, edgeHigh)).toBeNull();
      expect(assign(high, edgeHigh)).not.toBeNull();
    });

    it("S39 AS-19: widening a range only adds units and never changes a unit's variant (property)", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 40 }),
          fc.integer({ min: 1, max: 10_000 }),
          fc.integer({ min: 0, max: 9_999 }),
          (unit, to, extra) => {
            const wider = Math.min(10_000, to + extra);
            const narrow = assign(
              experiment({ layerFrom: 0, layerTo: to }),
              unit,
            );
            const wide = assign(
              experiment({ layerFrom: 0, layerTo: wider }),
              unit,
            );
            if (narrow !== null) expect(wide).toBe(narrow);
          },
        ),
      );
    });
  });

  describe('assignAll', () => {
    it('S39 AS-20: a user experiment is assigned from the user id and a visitor experiment from the anonymous id', () => {
      const user = experiment({ key: 'user-exp', unit: 'user' });
      const visitor = experiment({
        key: 'visitor-exp',
        unit: 'visitor',
        layer: 'other-layer',
      });
      const both = assignAll([user, visitor], {
        userId: 'user-1',
        anonymousId: 'anon-12345678',
      });
      expect(both).toEqual({
        'user-exp': { variant: assign(user, 'user-1') },
        'visitor-exp': { variant: assign(visitor, 'anon-12345678') },
      });
      expect(
        assignAll([user, visitor], { anonymousId: 'anon-12345678' }),
      ).toEqual({
        'visitor-exp': { variant: assign(visitor, 'anon-12345678') },
      });
      expect(assignAll([user, visitor], { userId: 'user-1' })).toEqual({
        'user-exp': { variant: assign(user, 'user-1') },
      });
      expect(assignAll([user, visitor], {})).toEqual({});
    });
  });
});
