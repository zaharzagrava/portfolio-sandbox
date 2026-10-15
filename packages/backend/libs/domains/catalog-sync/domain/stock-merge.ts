/**
 * Three-way stock merge of (base B, local L, remote R); pure (AS-45, FR-041).
 *
 * - `result = L + R - B`, clamped to `[0, 1e9]`; a negative sum is an `oversold` conflict, a sum above the cap a
 *   `quantity_limit` conflict. Both sides are then set to the clamped value.
 * - When `L === R` the sides already agree: the result is that value (`converged`). The sum is still checked against
 *   the cap, so `(5, 1e9, 1e9)` reports `quantity_limit`; a negative sum is not a conflict there (nothing to repair).
 */
export const MAX_STOCK = 1_000_000_000;

export type MergeAction = 'none' | 'pull' | 'push' | 'merge' | 'converged';
export type MergeConflict = 'oversold' | 'quantity_limit';

export interface MergeResult {
  action: MergeAction;
  /** Delta to apply to the local quantity (0 = none). */
  localDelta: number;
  /** Absolute value to write to the provider, `null` = provider already holds the result. */
  pushValue: number | null;
  /** The new base: the value both sides hold after the plan is carried out. */
  result: number;
  conflict?: MergeConflict;
}

function assertStock(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_STOCK)
    throw new RangeError(`${name} must be an integer in [0, ${MAX_STOCK}]`);
}

export function merge(
  base: number,
  local: number,
  remote: number,
): MergeResult {
  assertStock('base', base);
  assertStock('local', local);
  assertStock('remote', remote);

  const sum = local + remote - base;
  let conflict: MergeConflict | undefined;
  if (sum > MAX_STOCK) conflict = 'quantity_limit';
  else if (sum < 0 && local !== remote) conflict = 'oversold';

  if (local === remote) {
    const result = local;
    return withConflict(
      {
        action: local === base ? 'none' : 'converged',
        localDelta: 0,
        pushValue: null,
        result,
      },
      conflict,
    );
  }

  const result = Math.min(MAX_STOCK, Math.max(0, sum));
  const localDelta = result - local;
  const pushValue = result === remote ? null : result;
  let action: MergeAction;
  if (localDelta !== 0 && pushValue !== null) action = 'merge';
  else if (localDelta !== 0) action = 'pull';
  else action = 'push';
  return withConflict({ action, localDelta, pushValue, result }, conflict);
}

function withConflict(
  out: MergeResult,
  conflict: MergeConflict | undefined,
): MergeResult {
  return conflict ? { ...out, conflict } : out;
}
