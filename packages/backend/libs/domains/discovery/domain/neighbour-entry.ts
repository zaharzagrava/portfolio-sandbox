import type { StoredEntry } from './recommendation-ports';

export interface NeighbourEntry {
  id: string;
  /** Cosine in (0, 1]. */
  score: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keeps the stored entries that can be trusted (S34 FR-008): the member is a UUID other than the requested product and
 * the score is a finite number in (0, 1]. Order is kept; every other entry is counted as skipped, never an error.
 */
export function sanitiseEntries(
  productId: string,
  raw: readonly StoredEntry[],
): { entries: NeighbourEntry[]; skipped: number } {
  const entries: NeighbourEntry[] = [];
  for (const { member, score } of raw) {
    if (
      typeof member === 'string' &&
      UUID.test(member) &&
      member.toLowerCase() !== productId.toLowerCase() &&
      typeof score === 'number' &&
      Number.isFinite(score) &&
      score > 0 &&
      score <= 1
    )
      entries.push({ id: member, score });
  }
  return { entries, skipped: raw.length - entries.length };
}
