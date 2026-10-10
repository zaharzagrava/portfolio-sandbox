export interface Candidate {
  productId: string;
  /** Unrounded cosine (hop 1) or the decayed path score (hop 2). */
  score: number;
  hops: 1 | 2;
}

/** Byte (UTF-16 code unit) order of two ids; never `localeCompare`, which depends on the host locale (S34 A6). */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Total order of a rail (S34 FR-007): direct neighbours before indirect ones, then score descending, then `productId`
 * ascending. The result does not depend on the order of the input.
 */
export function rankCandidates(
  candidates: readonly Candidate[],
  limit: number,
): Candidate[] {
  return [...candidates]
    .sort(
      (a, b) =>
        a.hops - b.hops || b.score - a.score || byId(a.productId, b.productId),
    )
    .slice(0, limit);
}
