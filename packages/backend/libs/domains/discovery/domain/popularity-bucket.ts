export const MAX_POPULARITY_BUCKET = 10;

/**
 * Damped popularity bucket of the clicks in the last 30 days (FR-027, AS-86):
 * `min(10, floor(2 * log10(1 + clicks)))`. 0 for no clicks, monotone, bounded at 10 (reached at 99,999 clicks), and a
 * tenfold increase of clicks raises the bucket by at most 2. Non-finite and negative counts are 0.
 */
export function popularityBucket(clicks: number): number {
  if (!(clicks >= 1)) return 0;
  return Math.min(
    MAX_POPULARITY_BUCKET,
    Math.floor(2 * Math.log10(1 + Math.floor(clicks))),
  );
}
