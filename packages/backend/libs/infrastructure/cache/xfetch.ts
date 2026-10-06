/**
 * Probabilistic early expiration ("XFetch", Vattani et al. 2015): each reader
 * recomputes *before* expiry with a probability that rises as expiry nears
 * and with how long the value takes to compute (`deltaMs`). Expensive hot keys
 * get refreshed by one early reader instead of stampeding at the exact TTL.
 *
 *   recompute if  now - deltaMs * beta * ln(rand)  >=  expiresAt
 */
export function shouldRecomputeEarly(
  nowMs: number,
  expiresAtMs: number,
  deltaMs: number,
  beta = 1,
  random: () => number = Math.random,
): boolean {
  const r = Math.max(random(), Number.MIN_VALUE); // ln(0) = -Infinity
  return nowMs - deltaMs * beta * Math.log(r) >= expiresAtMs;
}

/** ±`spread` relative jitter so keys written together don't expire together (avalanche). */
export function jitterTtl(ttlMs: number, spread = 0.1, random: () => number = Math.random): number {
  return Math.round(ttlMs * (1 - spread + 2 * spread * random()));
}
