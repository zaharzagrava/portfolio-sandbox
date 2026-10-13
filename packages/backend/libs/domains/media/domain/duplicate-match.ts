/** Perceptual-hash matching rules (S29 FR-030–FR-032). Pure: no framework, no clock, no I/O. */
export const NEAR_DUPLICATE_BITS = 3;
/** One band lookup returns at most this many candidates; hitting it is counted (AS-28). */
export const CANDIDATE_CAP = 500;
const MIN_BITS_EACH_WAY = 8;

export interface DuplicateCandidate {
  id: string;
  hash: string;
}
export interface DuplicateMatch {
  id: string;
  distance: number;
}

/** Number of differing bits between two 64-bit hex hashes. */
export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/**
 * 4 × 16-bit bands of the 64-bit hash (index keys for candidates). Two hashes within distance 3 share at least one
 * identical band (pigeonhole), so four lookups cannot miss a match.
 */
export function bands(hash: string): [number, number, number, number] {
  return [0, 1, 2, 3].map((i) =>
    parseInt(hash.slice(i * 4, i * 4 + 4), 16),
  ) as [number, number, number, number];
}

/** A blank or near-uniform image (fewer than 8 set or fewer than 8 clear bits) matches nothing. */
export function isNearUniform(hash: string): boolean {
  let set = 0;
  let x = BigInt(`0x${hash}`);
  while (x) {
    set += Number(x & 1n);
    x >>= 1n;
  }
  return set < MIN_BITS_EACH_WAY || 64 - set < MIN_BITS_EACH_WAY;
}

/**
 * The nearest candidate within `NEAR_DUPLICATE_BITS`; ties go to the smallest id (ids are time-ordered, so the
 * earliest photo). Near-uniform hashes, on either side, never match.
 */
export function findNearest(
  hash: string,
  candidates: readonly DuplicateCandidate[],
): DuplicateMatch | null {
  if (isNearUniform(hash)) return null;
  let best: DuplicateMatch | null = null;
  for (const candidate of candidates) {
    if (isNearUniform(candidate.hash)) continue;
    const distance = hamming(hash, candidate.hash);
    if (distance > NEAR_DUPLICATE_BITS) continue;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && candidate.id < best.id)
    )
      best = { id: candidate.id, distance };
  }
  return best;
}
