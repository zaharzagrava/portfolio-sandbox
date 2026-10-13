import { PICKUP_LIMITS } from '@marketplace-sandbox/contracts';

export interface StockState {
  quantity: number;
  version: number;
}

export type SetDecision =
  | { kind: 'apply'; version: number }
  | { kind: 'noop'; version: number }
  | { kind: 'conflict'; currentVersion: number };

/**
 * Absolute stock set (S19 FR-010, FR-011). `expectedVersion` is checked first (`0` means "no row yet"); then a set to
 * the quantity already held changes nothing (no version, no event); otherwise the version rises by one. The SQL of the
 * repository mirrors this table and the store makes it atomic; this function is the readable statement of the rule.
 */
export function decideSet(
  current: StockState | null,
  input: { quantity: number; expectedVersion?: number },
): SetDecision {
  const currentVersion = current?.version ?? 0;
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== currentVersion
  )
    return { kind: 'conflict', currentVersion };
  if (current && current.quantity === input.quantity)
    return { kind: 'noop', version: current.version };
  return { kind: 'apply', version: currentVersion + 1 };
}

export type AdjustDecision =
  | { kind: 'apply'; quantity: number }
  | { kind: 'insufficient'; available: number }
  | { kind: 'limit' };

/** Relative change (S19 FR-012): the result must stay within `0…1 000 000`; a missing row counts as 0. */
export function decideAdjust(
  current: number | null,
  delta: number,
): AdjustDecision {
  const available = current ?? 0;
  const next = available + delta;
  if (next < 0) return { kind: 'insufficient', available };
  if (next > PICKUP_LIMITS.stockMax) return { kind: 'limit' };
  return { kind: 'apply', quantity: next };
}
