import {
  chiSquarePValue,
  normalCdf,
  srmCheck,
  twoProportionZTest,
} from './stats';

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

  it('z-test: 10% vs 12% on 10k each is significant; 10% vs 10.2% is not', () => {
    const significant = twoProportionZTest(
      { conversions: 1_000, exposures: 10_000 },
      { conversions: 1_200, exposures: 10_000 },
    );
    expect(significant.pValue).toBeLessThan(0.001);
    expect(significant.lift).toBeCloseTo(0.2, 6);
    expect(
      twoProportionZTest(
        { conversions: 1_000, exposures: 10_000 },
        { conversions: 1_020, exposures: 10_000 },
      ).pValue,
    ).toBeGreaterThan(0.5);
  });

  it('SRM: 60/40 on a 50/50 split is flagged, 5,030/4,970 is not', () => {
    expect(srmCheck([6_000, 4_000], [50, 50]).mismatch).toBe(true);
    expect(srmCheck([5_030, 4_970], [50, 50]).mismatch).toBe(false);
  });
});
