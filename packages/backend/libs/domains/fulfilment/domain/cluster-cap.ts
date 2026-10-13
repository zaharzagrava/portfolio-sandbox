import type { PickupClusterCell } from '@marketplace-sandbox/contracts';

/** A map answer never holds more cells than this (S19 FR-026, SC-007). */
export const MAX_CLUSTER_CELLS = 500;

/**
 * Keeps the 500 cells with the most offers (equal offers by `cellId`) and says whether it cut. `omittedByEngine`
 * is true when the index itself left buckets out of its answer; totals of omitted cells are never invented.
 */
export function capClusterCells(
  cells: PickupClusterCell[],
  omittedByEngine = false,
): { cells: PickupClusterCell[]; truncated: boolean } {
  const ordered = [...cells].sort(
    (a, b) =>
      b.offers - a.offers ||
      (a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : 0),
  );
  return {
    cells: ordered.slice(0, MAX_CLUSTER_CELLS),
    truncated: omittedByEngine || ordered.length > MAX_CLUSTER_CELLS,
  };
}
