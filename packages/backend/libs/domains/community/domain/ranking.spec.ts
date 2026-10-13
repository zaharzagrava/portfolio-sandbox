import { hotScore, wilsonLowerBound } from './ranking';

/** 2024-01-01T00:00:00Z in seconds: the epoch `E` of FR-032. */
const E = 1_704_067_200;
const at = (secondsAfterEpoch: number) =>
  new Date((E + secondsAfterEpoch) * 1000);

describe('S25 FR-032 hot score', () => {
  it.each([
    // [ups, downs, seconds after E, expected]
    [0, 0, 0, 0],
    [0, 0, 45_000, 1],
    [1, 0, 0, 0], // log10(1) = 0
    [10, 0, 0, 1],
    [100, 0, 0, 2],
    [0, 10, 0, -1],
    [0, 100, 0, -2],
    [10, 10, 45_000, 1], // zero net contributes no order term
    [10, 0, 45_000, 2],
    [3, 0, 12_345, Math.log10(3) + 12_345 / 45_000],
    [0, 3, 12_345, -Math.log10(3) + 12_345 / 45_000],
  ])(
    'S25 AS-34: (%i ups, %i downs, +%i s) scores %f to 7 decimals',
    (ups, downs, seconds, expected) => {
      expect(hotScore(ups, downs, at(seconds))).toBeCloseTo(expected, 7);
    },
  );

  it('S25 AS-34: ten times more net votes are worth exactly 45,000 seconds', () => {
    const a = hotScore(10, 0, at(100_000));
    const b = hotScore(100, 0, at(100_000));
    expect(b - a).toBeCloseTo(1, 7);
    expect(hotScore(10, 0, at(145_000))).toBeCloseTo(b, 7);
  });

  it('S25 AS-34: the result is rounded to 7 decimals', () => {
    const score = hotScore(7, 2, at(54_321));
    expect(Math.round(score * 1e7) / 1e7).toBe(score);
  });

  it('S25 AS-33: a newer post with traction outranks an older post with a big score', () => {
    expect(hotScore(10, 0, at(200_000))).toBeGreaterThan(
      hotScore(1_000, 0, at(0)),
    );
  });
});

describe('S25 FR-033 Wilson lower bound', () => {
  it.each([
    [0, 0, 0],
    [1, 0, 0.2065],
    [90, 10, 0.8256],
    [9, 1, 0.5958],
  ])('S25 AS-42: (%i, %i) is %f within 0.001', (ups, downs, expected) => {
    expect(Math.abs(wilsonLowerBound(ups, downs) - expected)).toBeLessThan(
      0.001,
    );
  });

  it('S25 AS-42: one up-vote ranks below 9 up / 1 down, and 9/1 ranks below 90/10', () => {
    expect(wilsonLowerBound(1, 0)).toBeLessThan(wilsonLowerBound(9, 1));
    expect(wilsonLowerBound(9, 1)).toBeLessThan(wilsonLowerBound(90, 10));
  });

  it('S25 AS-42: more up-votes never lower the bound and more down-votes never raise it', () => {
    for (let ups = 0; ups < 30; ups++)
      for (let downs = 0; downs < 30; downs++) {
        const base = wilsonLowerBound(ups, downs);
        expect(wilsonLowerBound(ups + 1, downs)).toBeGreaterThanOrEqual(
          base - 1e-12,
        );
        expect(wilsonLowerBound(ups, downs + 1)).toBeLessThanOrEqual(
          base + 1e-12,
        );
      }
  });

  it('S25 AS-42: a comment with no votes ranks below both voted comments', () => {
    expect(wilsonLowerBound(0, 0)).toBeLessThan(wilsonLowerBound(1, 0));
  });
});
