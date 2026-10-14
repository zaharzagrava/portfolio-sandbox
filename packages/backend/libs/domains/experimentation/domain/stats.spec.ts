import fc from 'fast-check';
import {
  SRM_P_THRESHOLD,
  chiSquarePValue,
  compareToControl,
  normalCdf,
  srmCheck,
} from './stats';

const arm = (conversions: number, exposures: number) => ({
  conversions,
  exposures,
});

/** Experiment readouts depend on these; checked against textbook values. */
describe('experiment statistics', () => {
  it('normal CDF', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.644854)).toBeCloseTo(0.05, 4);
  });

  it('chi-square p-values', () => {
    expect(chiSquarePValue(3.841459, 1)).toBeCloseTo(0.05, 4);
    expect(chiSquarePValue(10.828, 1)).toBeCloseTo(0.001, 4);
    expect(chiSquarePValue(5.991465, 2)).toBeCloseTo(0.05, 4);
  });

  describe('comparison with control', () => {
    it('S39 AS-42: 10% vs 12% on 10,000 each: the pooled z, the p-value, the unpooled interval and the lift', () => {
      const result = compareToControl(
        arm(1_000, 10_000),
        arm(1_200, 10_000),
        0.05,
      );
      // pooled p = 0.11, se = sqrt(0.11 * 0.89 * 2 / 10000) = 0.0044252; z = 0.02 / se
      expect(result.absoluteDifference).toBeCloseTo(0.02, 12);
      expect(result.relativeLift).toBeCloseTo(0.2, 12);
      expect(result.zScore).toBeCloseTo(4.5196, 3);
      expect(result.pValue).toBeCloseTo(6.2e-6, 6);
      // unpooled se = sqrt(0.1 * 0.9 / 10000 + 0.12 * 0.88 / 10000) = 0.0044227
      expect(result.confidenceInterval95[0]).toBeCloseTo(
        0.02 - 1.959964 * 0.0044227,
        5,
      );
      expect(result.confidenceInterval95[1]).toBeCloseTo(
        0.02 + 1.959964 * 0.0044227,
        5,
      );
      expect(result.significant).toBe(true);
    });

    it('S39 AS-42: 10% vs 10.2% is not significant and the interval contains zero', () => {
      const result = compareToControl(
        arm(1_000, 10_000),
        arm(1_020, 10_000),
        0.05,
      );
      expect(result.pValue).toBeGreaterThan(0.5);
      expect(result.significant).toBe(false);
      expect(result.confidenceInterval95[0]).toBeLessThan(0);
      expect(result.confidenceInterval95[1]).toBeGreaterThan(0);
    });

    it('S39 AS-42: the difference is treatment minus control and a lower treatment gives a negative z and lift', () => {
      const result = compareToControl(
        arm(1_200, 10_000),
        arm(1_000, 10_000),
        0.05,
      );
      expect(result.absoluteDifference).toBeCloseTo(-0.02, 12);
      expect(result.relativeLift).toBeCloseTo(-1 / 6, 12);
      expect(result.zScore).toBeLessThan(0);
      expect(result.pValue).toBeCloseTo(6.2e-6, 6);
    });

    it('S39 AS-47: a p-value between 0.025 and 0.05 is significant at 0.05 and not at the Bonferroni 0.025', () => {
      const result = compareToControl(arm(100, 1_000), arm(130, 1_000), 0.05);
      expect(result.pValue).toBeGreaterThan(0.025);
      expect(result.pValue).toBeLessThan(0.05);
      expect(result.significant).toBe(true);
      expect(
        compareToControl(arm(100, 1_000), arm(130, 1_000), 0.025).significant,
      ).toBe(false);
    });

    it('S39 AS-48: zero control conversions give a null lift and finite numbers', () => {
      const result = compareToControl(arm(0, 1_000), arm(20, 1_000), 0.05);
      expect(result.relativeLift).toBeNull();
      expect(result.absoluteDifference).toBeCloseTo(0.02, 12);
      for (const n of [
        result.zScore,
        result.pValue,
        ...result.confidenceInterval95,
      ])
        expect(Number.isFinite(n)).toBe(true);
      expect(result.significant).toBe(true);
    });

    it('S39 AS-48: two arms without conversions give z 0, p 1 and a lift of null', () => {
      const result = compareToControl(arm(0, 500), arm(0, 600), 0.05);
      expect(result).toEqual({
        absoluteDifference: 0,
        relativeLift: null,
        zScore: 0,
        pValue: 1,
        confidenceInterval95: [0, 0],
        significant: false,
      });
    });

    it('S39 AS-48: an arm without exposures is treated as a zero rate, never NaN', () => {
      for (const [c, t] of [
        [arm(0, 0), arm(5, 100)],
        [arm(5, 100), arm(0, 0)],
        [arm(0, 0), arm(0, 0)],
      ] as const) {
        const result = compareToControl(c, t, 0.05);
        for (const n of [
          result.absoluteDifference,
          result.zScore,
          result.pValue,
          ...result.confidenceInterval95,
        ])
          expect(Number.isFinite(n)).toBe(true);
      }
    });

    it('S39 AS-48: every field is finite for any non-negative counts (property)', () => {
      const counts = fc
        .tuple(
          fc.integer({ min: 0, max: 1_000_000 }),
          fc.integer({ min: 0, max: 1_000_000 }),
        )
        .map(([a, b]) => arm(Math.min(a, b), Math.max(a, b)));
      fc.assert(
        fc.property(
          counts,
          counts,
          fc.double({ min: 0.001, max: 0.5, noNaN: true }),
          (c, t, alpha) => {
            const result = compareToControl(c, t, alpha);
            for (const n of [
              result.absoluteDifference,
              result.zScore,
              result.pValue,
              ...result.confidenceInterval95,
              ...(result.relativeLift === null ? [] : [result.relativeLift]),
            ])
              expect(Number.isFinite(n)).toBe(true);
            expect(result.pValue).toBeGreaterThanOrEqual(0);
            expect(result.pValue).toBeLessThanOrEqual(1);
            expect(result.confidenceInterval95[0]).toBeLessThanOrEqual(
              result.confidenceInterval95[1],
            );
          },
        ),
      );
    });
  });

  describe('sample ratio mismatch', () => {
    it('S39 AS-45: 60/40 on a 50/50 split is flagged, 5,030/4,970 is not', () => {
      expect(srmCheck([6_000, 4_000], [5_000, 5_000]).mismatch).toBe(true);
      const fine = srmCheck([5_030, 4_970], [5_000, 5_000]);
      expect(fine.mismatch).toBe(false);
      expect(fine.chiSquare).toBeCloseTo(0.36, 6);
      expect(fine.pValue).toBeCloseTo(0.5485, 3);
    });

    it('S39 AS-45: an exact three-way split has chi-square 0 and p-value 1', () => {
      expect(srmCheck([3_400, 3_300, 3_300], [3_400, 3_300, 3_300])).toEqual({
        chiSquare: 0,
        pValue: 1,
        mismatch: false,
      });
    });

    it('S39 AS-45: the threshold is p < 0.001 exactly (164 users off a 5,000 half is fine, 165 is not)', () => {
      expect(SRM_P_THRESHOLD).toBe(0.001);
      expect(srmCheck([5_164, 4_836], [5_000, 5_000]).mismatch).toBe(false);
      expect(srmCheck([5_165, 4_835], [5_000, 5_000]).mismatch).toBe(true);
    });

    it('S39 AS-45: no exposures is never a mismatch', () => {
      expect(srmCheck([0, 0], [5_000, 5_000])).toEqual({
        chiSquare: 0,
        pValue: 1,
        mismatch: false,
      });
    });
  });
});
