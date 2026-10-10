/**
 * `co / sqrt(na · nb)` (S34 FR-005): the shared baskets divided by the geometric mean of the products' basket counts, so a
 * product that is in every basket does not crowd out the closer match. Symmetric in `na` and `nb`.
 */
export const cosineScore = (co: number, na: number, nb: number): number =>
  co / Math.sqrt(na * nb);

/** The response shows 4 decimals; rounding happens only there, never in storage or ranking. */
export const roundScore = (score: number): number =>
  Math.round(score * 1e4) / 1e4;
