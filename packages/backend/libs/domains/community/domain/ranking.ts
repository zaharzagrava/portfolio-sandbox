/**
 * Ranking functions (lesson 10/05 #11). Shared by posts (hot/top) and comments (best).
 */

const EPOCH_SECONDS = 1_704_067_200; // 2024-01-01 - any fixed epoch works; only differences matter

/**
 * Reddit "hot": log10 of the net score + age bonus. Every 10× more net votes
 * is worth 45000 s (12.5 h) of recency, so a new post with some traction
 * outranks an old post with a big score - and a ranking computed at write
 * time stays correct forever (no periodic recompute: newer posts simply
 * start higher).
 */
export function hotScore(ups: number, downs: number, createdAt: Date): number {
  const net = ups - downs;
  const order = Math.log10(Math.max(Math.abs(net), 1));
  const sign = net > 0 ? 1 : net < 0 ? -1 : 0;
  const seconds = createdAt.getTime() / 1000 - EPOCH_SECONDS;
  return Math.round((sign * order + seconds / 45_000) * 1e7) / 1e7;
}

/**
 * Lower bound of the Wilson score interval for the upvote proportion (z=1.96
 * → 95%): "Best" comments. 1 up / 0 down (100%) ranks BELOW 90 up / 10 down,
 * because one vote proves nothing - plain up/(up+down) gets that wrong.
 */
export function wilsonLowerBound(ups: number, downs: number, z = 1.96): number {
  const n = ups + downs;
  if (n === 0) return 0;
  const p = ups / n;
  const z2 = z * z;
  return (
    (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) /
    (1 + z2 / n)
  );
}
