import { RevenueLimitExceededError } from './errors';
import type { Period } from './periods';

export { RevenueLimitExceededError } from './errors';

/** Low bits of the key hold the inverted last-sale slot: 604,800 s per week and 44,640 min per month fit in 20 bits. */
export const SLOT_BITS = 20;
export const SLOT_LIMIT = 2 ** SLOT_BITS;
/** Revenue ceiling per shop and period so that `revenue * 2^20 + slot` stays below 2^53 (exact in a double). */
export const MAX_REVENUE_MINOR = 2 ** 33 - 1;

/** The sale's slot in its period: whole seconds (weeks) or minutes (months) since the start, clamped to the key's range. */
export function slotOf(period: Period, at: Date): number {
  const slot = Math.floor(
    (at.getTime() - period.start.getTime()) / period.unitMs,
  );
  return Math.min(Math.max(slot, 0), SLOT_LIMIT - 1);
}

/**
 * Score = revenue * 2^20 + (2^20 - 1 - slot): higher revenue wins; at equal revenue the earlier last-sale slot wins;
 * equal scores are ordered by the store (descending member, so the larger shop id first).
 */
export function rankingKey(revenueMinor: number, slot: number): number {
  if (!Number.isSafeInteger(revenueMinor) || revenueMinor < 0)
    throw new RangeError(
      `revenue must be a non-negative integer: ${revenueMinor}`,
    );
  if (revenueMinor > MAX_REVENUE_MINOR)
    throw new RevenueLimitExceededError(revenueMinor);
  const clamped = Math.min(Math.max(Math.trunc(slot), 0), SLOT_LIMIT - 1);
  return revenueMinor * SLOT_LIMIT + (SLOT_LIMIT - 1 - clamped);
}

export const revenueOfKey = (key: number): number =>
  Math.floor(key / SLOT_LIMIT);
