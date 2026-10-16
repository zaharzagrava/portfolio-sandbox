export interface ChunkOccurrence {
  hash: string;
  occurrences: number;
}

export interface ChunkDelta {
  hash: string;
  delta: number;
}

/**
 * Occurrences per distinct hash of an ordered chunk list, sorted by hash (S31 FR-030, AS-44). A hash listed twice counts
 * twice; sorting makes every writer take chunk-row locks in the same order, so concurrent commits cannot deadlock.
 */
export function occurrencesOf(hashes: readonly string[]): ChunkOccurrence[] {
  const counts = new Map<string, number>();
  for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  return [...counts]
    .map(([hash, occurrences]) => ({ hash, occurrences }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
}

/** The reference-count change when a list `before` is replaced by `after`; hashes whose count is unchanged are omitted. */
export function referenceDelta(
  before: readonly string[],
  after: readonly string[],
): ChunkDelta[] {
  const delta = new Map<string, number>();
  for (const { hash, occurrences } of occurrencesOf(before))
    delta.set(hash, -occurrences);
  for (const { hash, occurrences } of occurrencesOf(after))
    delta.set(hash, (delta.get(hash) ?? 0) + occurrences);
  return [...delta]
    .filter(([, d]) => d !== 0)
    .map(([hash, d]) => ({ hash, delta: d }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
}
