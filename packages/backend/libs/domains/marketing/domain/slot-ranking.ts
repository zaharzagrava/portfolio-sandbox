export interface SlotCandidate {
  campaignId: string;
  shopId: string;
  cpcMinor: number;
}

/** CPC descending, then campaign id ascending: a total order, so the same candidates give the same slots on every call. */
const byRank = (a: SlotCandidate, b: SlotCandidate): number =>
  b.cpcMinor - a.cpcMinor ||
  (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0);

/**
 * FR-010, AS-23: at most one slot per shop (the shop's best campaign), ordered by rank, cut to `limit`.
 * Pure and input-order independent.
 */
export function selectSlots<T extends SlotCandidate>(
  candidates: readonly T[],
  limit: number,
): T[] {
  const bestPerShop = new Map<string, T>();
  for (const candidate of candidates) {
    const kept = bestPerShop.get(candidate.shopId);
    if (!kept || byRank(candidate, kept) < 0)
      bestPerShop.set(candidate.shopId, candidate);
  }
  return [...bestPerShop.values()].sort(byRank).slice(0, Math.max(0, limit));
}
