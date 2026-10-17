import type { FunctionOutputDto } from '@marketplace-sandbox/contracts';

/** A line as the amount rules see it (integer minor units). */
export interface PricedLine {
  unitPriceMinor: number;
  quantity: number;
}

const BPS_SCALE = 100;
const FULL_BPS = 10_000n;

/** Percentage values carry at most two decimals; they are held as integer basis points. */
function toBasisPoints(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const bps = Math.round(value * BPS_SCALE);
  if (Math.abs(value * BPS_SCALE - bps) > 1e-6) return null;
  return Math.min(bps, Number(FULL_BPS));
}

const gross = (line: PricedLine): number => line.unitPriceMinor * line.quantity;

/**
 * Turns one function's validated output into one integer discount per line (AS-26). Several discounts on a line add up
 * and are clamped to the line's gross. Returns `null` when the output is invalid for these lines (a `lineIndex` outside
 * them, a non-integer `fixedPerUnit`, a non-finite value, more than two decimals): the function then counts as failed.
 */
export function functionDiscounts(
  lines: readonly PricedLine[],
  output: FunctionOutputDto,
): number[] | null {
  const perLine = lines.map(() => 0n);
  for (const d of output.discounts) {
    const line = lines[d.lineIndex];
    if (!line || !Number.isInteger(d.lineIndex)) return null;
    if (!Number.isFinite(d.value) || d.value <= 0) return null;
    let amount: bigint;
    if (d.type === 'fixedPerUnit') {
      if (!Number.isInteger(d.value)) return null;
      amount =
        BigInt(Math.min(d.value, line.unitPriceMinor)) * BigInt(line.quantity);
    } else {
      const bps = toBasisPoints(d.value);
      if (bps === null) return null;
      amount =
        (BigInt(line.unitPriceMinor) * BigInt(line.quantity) * BigInt(bps)) /
        FULL_BPS;
    }
    perLine[d.lineIndex] += amount;
  }
  return perLine.map((sum, i) => {
    const cap = BigInt(gross(lines[i]));
    return Number(sum > cap ? cap : sum);
  });
}

/**
 * The shop's amount: per line the largest discount among the functions (no stacking), summed, clamped to the shop's
 * gross. Independent of the order of `vectors`.
 */
export function shopDiscount(
  lines: readonly PricedLine[],
  vectors: readonly (readonly number[])[],
): number {
  let total = 0n;
  let cap = 0n;
  lines.forEach((line, i) => {
    cap += BigInt(gross(line));
    let best = 0;
    for (const vector of vectors) best = Math.max(best, vector[i] ?? 0);
    const lineGross = gross(line);
    total += BigInt(Math.min(Math.max(best, 0), lineGross));
  });
  return Number(total > cap ? cap : total);
}
