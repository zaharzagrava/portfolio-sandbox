/**
 * The payout amount: the available balance minus a reserve, bounded by a minimum and a cap (S15 FR-006, FR-011, FR-012).
 * Pure: money is integer minor units and the arithmetic is BigInt, because `balance x bps` exceeds 2^53 long before
 * the balance does.
 */
export const MAX_RESERVE_BPS = 5000;

const BPS_BASE = 10_000n;

export interface ReserveSplit {
  reserveMinor: number;
  payoutMinor: number;
}

/** `reserve = ceil(balance x bps / 10000)` (rounds up, in favour of the platform); `payout = balance - reserve`. */
export function computeReserve(
  balanceMinor: number,
  bps: number,
): ReserveSplit {
  if (!Number.isSafeInteger(balanceMinor) || balanceMinor < 0)
    throw new RangeError('balance must be a non-negative safe integer');
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_RESERVE_BPS)
    throw new RangeError(
      `reserve must be an integer from 0 to ${MAX_RESERVE_BPS} bps`,
    );
  const balance = BigInt(balanceMinor);
  const reserve = (balance * BigInt(bps) + (BPS_BASE - 1n)) / BPS_BASE;
  return {
    reserveMinor: Number(reserve),
    payoutMinor: Number(balance - reserve),
  };
}

export interface PayoutLimits {
  minMinor: number;
  capMinor: number;
}

export type PayoutPlan =
  | { kind: 'pay'; amountMinor: number; reserveHeldMinor: number }
  | { kind: 'skip'; reason: 'below_minimum' };

/**
 * The minimum applies to the balance and again to what is left after the reserve (inclusive both times); the cap
 * limits the payout and is not a reserve, so a capped balance holds only the reserve it was computed with.
 */
export function planPayout(
  balanceMinor: number,
  bps: number,
  limits: PayoutLimits,
): PayoutPlan {
  const skip: PayoutPlan = { kind: 'skip', reason: 'below_minimum' };
  if (!Number.isSafeInteger(balanceMinor) || balanceMinor < limits.minMinor)
    return skip;
  const { reserveMinor, payoutMinor } = computeReserve(balanceMinor, bps);
  if (payoutMinor < limits.minMinor) return skip;
  return {
    kind: 'pay',
    amountMinor: Math.min(payoutMinor, limits.capMinor),
    reserveHeldMinor: reserveMinor,
  };
}
