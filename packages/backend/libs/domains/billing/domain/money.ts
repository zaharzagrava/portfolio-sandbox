/**
 * Money is integer minor units everywhere (S17 FR-053). `BIGINT` columns arrive from the driver as strings: they are
 * parsed here, strictly, never with a bare `Number(...)`. The bounds in the catalog (price <= 100,000,000, quantity
 * <= 1000, a year of days) keep every product inside the safe-integer range; the helpers assert it.
 */
export function parseMinor(value: string | number | bigint | null): number {
  if (value === null) throw new Error('money value is null');
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint'
        ? Number(value)
        : /^-?\d+$/.test(value)
          ? Number(value)
          : Number.NaN;
  if (!Number.isSafeInteger(parsed))
    throw new Error('money value is not a safe integer');
  return parsed;
}

/** `unitAmount x quantity` for a per-seat price, `unitAmount` for a flat one. */
export function lineAmount(
  unitAmountMinor: number,
  perSeat: boolean,
  quantity: number,
): number {
  const amount = unitAmountMinor * (perSeat ? quantity : 1);
  if (!Number.isSafeInteger(amount))
    throw new Error('amount is outside the safe integer range');
  return amount;
}

/** Floor division on bigint (JavaScript's `/` truncates toward zero). */
export function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder !== 0n && remainder < 0n !== denominator < 0n
    ? quotient - 1n
    : quotient;
}

/** `numerator / denominator` rounded to the nearest integer, halves away from zero. Denominator must be positive. */
export function roundHalfAwayFromZero(
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (2n * magnitude + denominator) / (2n * denominator);
  return numerator < 0n ? -rounded : rounded;
}

export const toSafeNumber = (value: bigint): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw new Error('amount is outside the safe integer range');
  return n;
};
