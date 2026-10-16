/** Search radii (metres) and the candidate cap of one search (FR-013, A12). */
export const SEARCH_RADII_M: readonly number[] = [3_000, 6_000, 12_000];
export const MAX_CANDIDATES = 20;

export interface Candidate {
  courierId: string;
  distanceM: number;
}

/**
 * Replaceable ranking function (FR-013): distance ascending, courier id as tie-break. A courier found in several radius
 * steps counts once at the shortest distance, and the cap applies to the whole search, not per step.
 */
export function rankCandidates<T extends Candidate>(
  candidates: readonly T[],
  limit: number = MAX_CANDIDATES,
): T[] {
  const best = new Map<string, T>();
  for (const candidate of candidates) {
    const seen = best.get(candidate.courierId);
    if (!seen || candidate.distanceM < seen.distanceM)
      best.set(candidate.courierId, candidate);
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        a.distanceM - b.distanceM ||
        (a.courierId < b.courierId ? -1 : a.courierId > b.courierId ? 1 : 0),
    )
    .slice(0, limit);
}
