/**
 * The offset a partition may commit (S35 FR-020, R-2): the earliest first offset of any window or correction buffer that has
 * not been merged yet, or `lastConsumed + 1` when nothing is pending. `null` while nothing was consumed and nothing is
 * pending (there is nothing to commit). Committing only to the floor means a restart rebuilds the open windows; the
 * idempotent merge makes the replay harmless.
 */
export function commitFloor(
  lastConsumedOffset: number | null,
  pendingFirstOffsets: readonly number[],
): number | null {
  if (pendingFirstOffsets.length > 0) return Math.min(...pendingFirstOffsets);
  return lastConsumedOffset === null ? null : lastConsumedOffset + 1;
}
