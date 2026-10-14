/**
 * Drift between the fast store and the durable records (S11 FR-026, FR-028; research R-07). The durable records win:
 * during the sale a phantom surplus in the store is clamped down (never raised); after it, the unsold count comes from
 * the records and the difference is only measured.
 */

export type DriftKind =
  | 'none'
  | 'redis_low'
  | 'redis_high'
  | 'phantom_stock'
  | 'oversold';

export interface DriftInput {
  units: number;
  /** Sum of the buckets, negative counts as 0. */
  remainingFast: number;
  /** Units of flash reservations that are held or converted. */
  reserved: number;
  phase: 'during' | 'after';
}

export type DriftResult =
  | { kind: 'none' }
  | { kind: 'phantom_stock'; clampTo: number; excess: number }
  | { kind: 'oversold'; excess: number }
  | { kind: 'redis_low' | 'redis_high'; driftUnits: number };

export function classify(input: DriftInput): DriftResult {
  const { units, remainingFast, reserved } = input;
  if (input.phase === 'during') {
    if (reserved > units) return { kind: 'oversold', excess: reserved - units };
    if (remainingFast + reserved > units) {
      const clampTo = Math.max(0, units - reserved);
      return {
        kind: 'phantom_stock',
        clampTo,
        excess: remainingFast - clampTo,
      };
    }
    return { kind: 'none' };
  }
  const unsold = Math.max(0, units - reserved);
  if (remainingFast < unsold)
    return { kind: 'redis_low', driftUnits: unsold - remainingFast };
  if (remainingFast > unsold)
    return { kind: 'redis_high', driftUnits: remainingFast - unsold };
  return { kind: 'none' };
}

/**
 * New bucket contents after lowering the total to `target`: units are taken from the fullest buckets first (ties to
 * the lower index), so the result is deterministic. Never raises a bucket; a negative bucket is left as it is.
 */
export function clampPlan(contents: number[], target: number): number[] {
  const total = contents.reduce((s, c) => s + Math.max(0, c), 0);
  if (total <= target) return [...contents];
  const excess = total - target;

  // Lowest level L such that cutting every bucket down to L removes at most `excess` units.
  const removedAt = (level: number) =>
    contents.reduce((s, c) => s + Math.max(0, c - level), 0);
  let lo = 0;
  let hi = Math.max(...contents);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (removedAt(mid) <= excess) hi = mid;
    else lo = mid + 1;
  }
  const level = lo;
  const out = contents.map((c) => (c > level ? level : c));
  let rest = excess - removedAt(level);
  // The remainder (fewer units than buckets at the level) comes off one by one, lowest index first.
  for (let i = 0; i < out.length && rest > 0; i++) {
    if (out[i] === level && level > 0) {
      out[i] -= 1;
      rest -= 1;
    }
  }
  return out;
}
