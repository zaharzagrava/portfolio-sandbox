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
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export interface Proportion {
  conversions: number;
  exposures: number;
}

export function twoProportionZTest(control: Proportion, treatment: Proportion): { lift: number; z: number; pValue: number } {
  const p1 = control.conversions / control.exposures;
  const p2 = treatment.conversions / treatment.exposures;
  const pooled = (control.conversions + treatment.conversions) / (control.exposures + treatment.exposures);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / control.exposures + 1 / treatment.exposures));
  if (!se) return { lift: 0, z: 0, pValue: 1 };
  const z = (p2 - p1) / se;
  return { lift: p1 ? (p2 - p1) / p1 : 0, z, pValue: 2 * (1 - normalCdf(Math.abs(z))) };
}

/** Regularized upper incomplete gamma Q(s, x) - series / continued fraction (Numerical Recipes). */
function gammaQ(s: number, x: number): number {
  if (x <= 0) return 1;
  const lnGamma = (z: number) => {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = z;
    const tmp = z + 5.5 - (z + 0.5) * Math.log(z + 5.5);
    let ser = 1.000000000190015;
    for (const coef of c) ser += coef / ++y;
    return -tmp + Math.log((2.5066282746310005 * ser) / z);
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

export function chiSquarePValue(statistic: number, degreesOfFreedom: number): number {
  return gammaQ(degreesOfFreedom / 2, statistic / 2);
}

export function srmCheck(observed: number[], weights: number[]): { chiSquare: number; pValue: number; mismatch: boolean } {
  const total = observed.reduce((a, b) => a + b, 0);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const chiSquare = observed.reduce((acc, o, i) => {
    const expected = (total * weights[i]) / weightSum;
    return acc + (expected ? (o - expected) ** 2 / expected : 0);
  }, 0);
  const pValue = chiSquarePValue(chiSquare, observed.length - 1);
  return { chiSquare, pValue, mismatch: total > 0 && pValue < 0.001 };
}
