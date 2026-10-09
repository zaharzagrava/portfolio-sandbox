/**
 * Probabilistic early expiration ("XFetch", Vattani et al. 2015): each reader
 * recomputes *before* expiry with a probability that rises as expiry nears
 * and with how long the value takes to compute (`deltaMs`). Expensive hot keys
 * get refreshed by one early reader instead of stampeding at the exact TTL.
 *
 *   recompute if  now - deltaMs * beta * ln(rand)  >=  expiresAt
 *
 * `random` is the injected source (FR-045): a uniform draw in [0, 1).
 */
export function shouldRecomputeEarly(
  nowMs: number,
  expiresAtMs: number,
  deltaMs: number,
  beta: number,
  random: () => number,
): boolean {
  const r = Math.max(random(), Number.MIN_VALUE); // ln(0) = -Infinity
  return nowMs - deltaMs * beta * Math.log(r) >= expiresAtMs;
}

/** ±`spread` relative jitter so keys written together don't expire together (avalanche). */
export function jitterTtl(
  ttlMs: number,
  spread: number,
  random: () => number,
): number {
  return Math.round(ttlMs * (1 - spread + 2 * spread * random()));
}
