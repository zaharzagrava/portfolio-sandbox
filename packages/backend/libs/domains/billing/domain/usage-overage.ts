import { amountOutOfRange } from './errors';

/** Overage is billed per started block of this many units (S18 FR-024). */
export const OVERAGE_BLOCK = 1000;

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

function safeInteger(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw amountOutOfRange();
  return BigInt(value);
}

/** Units above the allowance: `max(0, used - included)`. */
export function overUnits(used: number, included: number): number {
  const over = safeInteger(used) - safeInteger(included);
  return over > 0n ? Number(over) : 0;
}

/**
 * `ceil(max(0, used - included) / 1000) x rate` in integer minor units (FR-024). Pure integer arithmetic: inputs
 * outside the safe integer range, negative inputs or a result beyond it reject `amount_out_of_range`, never wrap.
 */
export function overageAmount(
  used: number,
  included: number,
  overagePer1000Minor: number,
): number {
  const over = safeInteger(used) - safeInteger(included);
  const rate = safeInteger(overagePer1000Minor);
  if (over <= 0n) return 0;
  const blocks = (over + BigInt(OVERAGE_BLOCK) - 1n) / BigInt(OVERAGE_BLOCK);
  const amount = blocks * rate;
  if (amount > MAX) throw amountOutOfRange();
  return Number(amount);
}
