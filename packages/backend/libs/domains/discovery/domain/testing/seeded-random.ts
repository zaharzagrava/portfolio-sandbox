/** mulberry32: a small, fast PRNG with a fixed seed, so unit specs never use `Math.random` (S35 T43). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Zipf-like sampler over `n` ranks (rank 0 the heaviest) with exponent `s`. Uses the inverse CDF over precomputed
 * cumulative weights, so a sample costs one binary search.
 */
export function zipfSampler(
  n: number,
  s: number,
  random: () => number,
): () => number {
  const cumulative = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += 1 / Math.pow(i + 1, s);
    cumulative[i] = total;
  }
  return () => {
    const u = random() * total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}
