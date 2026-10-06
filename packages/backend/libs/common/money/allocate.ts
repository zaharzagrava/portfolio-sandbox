/**
 * Splits an integer amount of minor units (cents) across weighted parts so
 * that the parts always sum back to exactly `total` (largest remainder
 * method). Floating-point `total * share` rounding would leak or invent cents
 * - e.g. splitting 100 three ways yields 33+33+33=99.
 *
 * Ties in remainders go to the earlier part, which keeps the result
 * deterministic (same input → same split, important for idempotent invoices).
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total)) throw new RangeError('total must be a safe integer (minor units)');
  if (weights.length === 0) throw new RangeError('weights must not be empty');
  if (weights.some((w) => w < 0 || !Number.isFinite(w))) throw new RangeError('weights must be finite and >= 0');

  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  if (weightSum === 0) throw new RangeError('weights must not all be zero');

  const sign = total < 0 ? -1 : 1;
  const absTotal = Math.abs(total);

  const exact = weights.map((w) => (absTotal * w) / weightSum);
  const floored = exact.map(Math.floor);
  let remainder = absTotal - floored.reduce((sum, v) => sum + v, 0);

  const byRemainderDesc = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const { index } of byRemainderDesc) {
    if (remainder === 0) break;
    floored[index] += 1;
    remainder -= 1;
  }

  return floored.map((v) => v * sign);
}

/** Splits evenly: allocate(total, [1, 1, ..., 1]). */
export const allocateEvenly = (total: number, parts: number): number[] =>
  allocate(total, Array.from({ length: parts }, () => 1));
