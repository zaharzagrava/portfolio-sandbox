/**
 * Pure rules for the buckets of a flash sale (S11 FR-010, FR-020; data-model §3). The units of a drop live in N
 * counters spread over cluster slots; these functions decide how many go into each and how a purchase draws from them.
 * No Nest, no I/O: the Lua scripts in `infra/flash-scripts.ts` follow exactly this arithmetic.
 */

/** `units` split over `buckets`: the parts sum to `units`, differ by at most one, the larger parts come first. */
export function splitUnits(units: number, buckets: number): number[] {
  const base = Math.floor(units / buckets);
  const extra = units - base * buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < extra ? 1 : 0));
}

export interface BucketDraw {
  bucket: number;
  take: number;
}

export type DrawPlan =
  | { kind: 'ok'; draws: BucketDraw[] }
  | { kind: 'insufficient'; available: number };

/**
 * Plans taking `quantity` units from bucket contents, starting at `startBucket` and wrapping around. All or nothing:
 * the plan either covers the whole quantity or is `insufficient`. A draw never exceeds what a bucket holds and a
 * negative count is an empty bucket. The start bucket only changes the order of the draws (spreading buyers over
 * buckets), never whether the purchase succeeds.
 */
export function planDraw(
  contents: number[],
  quantity: number,
  startBucket: number,
): DrawPlan {
  const available = contents.reduce((s, c) => s + Math.max(0, c), 0);
  if (available < quantity) return { kind: 'insufficient', available };

  const draws: BucketDraw[] = [];
  let want = quantity;
  for (let i = 0; i < contents.length && want > 0; i++) {
    const bucket = (startBucket + i) % contents.length;
    const take = Math.min(want, Math.max(0, contents[bucket]));
    if (take > 0) {
      draws.push({ bucket, take });
      want -= take;
    }
  }
  return { kind: 'ok', draws };
}
