import { floorDiv, toSafeNumber } from './money';

/**
 * Largest-remainder split (S17 FR-042, AS-70, pattern P1110). `shares[i] / denominator` are the exact parts; the
 * result has each part rounded down plus one unit for the parts with the largest fractional remainder until the
 * parts add up to `total`. Ties go to the earlier part. Integer (bigint) arithmetic only.
 *
 * Preconditions: `denominator > 0`; `total` is an integer between `floor(sum)` and `floor(sum) + shares.length`
 * (true whenever `total` is the exact sum rounded once).
 */
export function splitByLargestRemainder(
  shares: bigint[],
  denominator: bigint,
  total: bigint,
): bigint[] {
  if (shares.length === 0) throw new Error('nothing to split');
  const floors = shares.map((s) => floorDiv(s, denominator));
  const remainders = shares.map((s, i) => s - floors[i] * denominator);
  let leftover = total - floors.reduce((a, b) => a + b, 0n);
  if (leftover < 0n || leftover > BigInt(shares.length))
    throw new Error('total is not reachable from the shares');
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder < b.remainder
          ? 1
          : -1,
    );
  const parts = [...floors];
  for (const { index } of order) {
    if (leftover === 0n) break;
    parts[index] += 1n;
    leftover -= 1n;
  }
  return parts;
}

/**
 * Splits an integer `amount` in proportion to non-negative integer `weights` (at least one positive): the parts are
 * integers, add up to `amount` exactly and each is within one unit of its exact share.
 */
export function allocate(amount: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(amount))
    throw new Error('amount must be an integer');
  if (
    weights.length === 0 ||
    weights.some((w) => !Number.isSafeInteger(w) || w < 0)
  )
    throw new Error('weights must be non-negative integers');
  const sum = weights.reduce((a, b) => a + BigInt(b), 0n);
  if (sum === 0n) throw new Error('at least one weight must be positive');
  const shares = weights.map((w) => BigInt(amount) * BigInt(w));
  return splitByLargestRemainder(shares, sum, BigInt(amount)).map(toSafeNumber);
}
