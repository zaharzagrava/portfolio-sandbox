/**
 * Experiment statistics (pure; unit-tested):
 *  - two-proportion z-test for conversion difference vs control,
 *  - sample ratio mismatch (SRM): chi-square goodness of fit of observed
 *    exposure counts vs configured weights. A low p (< 0.001) means the
 *    assignment or exposure logging is broken - results must not be trusted.
 */

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 erf approximation, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export interface Proportion {
  conversions: number;
  exposures: number;
}

/** z of the two-sided 95 % interval. */
const Z_95 = 1.959964;

export interface Comparison {
  /** Treatment rate minus control rate. */
  absoluteDifference: number;
  /** Relative to the control rate; `null` when the control rate is 0. */
  relativeLift: number | null;
  /** Pooled two-proportion z. */
  zScore: number;
  /** Two-sided p-value of that z. */
  pValue: number;
  /** 95 % interval of the absolute difference, unpooled. */
  confidenceInterval95: [number, number];
  /** `pValue < alpha`. */
  significant: boolean;
}

const rate = (arm: Proportion): number =>
  arm.exposures > 0 ? arm.conversions / arm.exposures : 0;

const finite = (value: number, fallback = 0): number =>
  Number.isFinite(value) ? value : fallback;

/**
 * A treatment arm against control (S39 FR-041): the difference, its relative lift, the pooled z-test (p-value) and the
 * unpooled 95 % interval of the difference. Every number is finite for any non-negative counts: an arm without exposures
 * has rate 0, equal zero rates give z 0 and p 1, and the lift is `null` when the control rate is 0.
 */
export function compareToControl(
  control: Proportion,
  treatment: Proportion,
  alpha: number,
): Comparison {
  const p1 = rate(control);
  const p2 = rate(treatment);
  const difference = p2 - p1;
  const pooled =
    control.exposures + treatment.exposures > 0
      ? (control.conversions + treatment.conversions) /
        (control.exposures + treatment.exposures)
      : 0;
  const pooledSe = Math.sqrt(
    pooled *
      (1 - pooled) *
      ((control.exposures ? 1 / control.exposures : 0) +
        (treatment.exposures ? 1 / treatment.exposures : 0)),
  );
  const zScore = pooledSe > 0 ? finite(difference / pooledSe) : 0;
  // The CDF approximation is off by 1e-9 at 0: equal rates are exactly "no evidence", p = 1.
  const pValue =
    zScore === 0
      ? 1
      : Math.min(
          1,
          Math.max(0, finite(2 * (1 - normalCdf(Math.abs(zScore))), 1)),
        );
  const se = Math.sqrt(
    (control.exposures ? (p1 * (1 - p1)) / control.exposures : 0) +
      (treatment.exposures ? (p2 * (1 - p2)) / treatment.exposures : 0),
  );
  const half = finite(Z_95 * se);
  return {
    absoluteDifference: difference,
    relativeLift: p1 > 0 ? finite(difference / p1) : null,
    zScore,
    pValue,
    confidenceInterval95: [difference - half, difference + half],
    significant: pValue < alpha,
  };
}

/** Regularized upper incomplete gamma Q(s, x) - series / continued fraction (Numerical Recipes). */
function gammaQ(s: number, x: number): number {
  if (x <= 0) return 1;
  const lnGamma = (z: number) => {
    const c = [
      76.18009172947146, -86.50532032941678, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
    ];
    let y = z;
    const tmp = z + 5.5 - (z + 0.5) * Math.log(z + 5.5);
    let ser = 1.000000000190015;
    for (const coef of c) ser += coef / ++y;
    return -tmp + Math.log((2.5066282746310007 * ser) / z);
  };
  if (x < s + 1) {
    let sum = 1 / s;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (s + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + s * Math.log(x) - lnGamma(s));
  }
  let b = x + 1 - s;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.exp(-x + s * Math.log(x) - lnGamma(s)) * h;
}

export function chiSquarePValue(
  statistic: number,
  degreesOfFreedom: number,
): number {
  return gammaQ(degreesOfFreedom / 2, statistic / 2);
}

/** A sample ratio mismatch is a chi-square p-value below this (S39 FR-042): the data is broken, not the variant. */
export const SRM_P_THRESHOLD = 0.001;

export function srmCheck(
  observed: number[],
  weights: number[],
): { chiSquare: number; pValue: number; mismatch: boolean } {
  const total = observed.reduce((a, b) => a + b, 0);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || weightSum === 0)
    return { chiSquare: 0, pValue: 1, mismatch: false };
  const chiSquare = observed.reduce((acc, o, i) => {
    const expected = (total * weights[i]) / weightSum;
    return acc + (expected ? (o - expected) ** 2 / expected : 0);
  }, 0);
  const pValue =
    chiSquare === 0 ? 1 : chiSquarePValue(chiSquare, observed.length - 1);
  return { chiSquare, pValue, mismatch: pValue < SRM_P_THRESHOLD };
}
