/**
 * Commission of a sale line (S16 FR-011): `floor((lineTotalMinor × rateBps + 5000) / 10000)`, half up, integers only.
 * The product reaches 1e16 for a 1e12 line at 10,000 bps, past 2^53, so the arithmetic is done in `BigInt`. Totals
 * are sums of per-line results (never one rounding of a total). `StatementReader` repeats the same formula in SQL
 * (`bigint` arithmetic) and `statement-read.e2e-spec.ts` pins the two together.
 */
export const MAX_RATE_BPS = 10_000;

export function commissionOf(lineTotalMinor: number, rateBps: number): number {
  if (!Number.isInteger(lineTotalMinor) || lineTotalMinor < 0)
    throw new RangeError('lineTotalMinor must be a non-negative integer');
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > MAX_RATE_BPS)
    throw new RangeError('rateBps must be an integer from 0 to 10000');
  return Number(
    (BigInt(lineTotalMinor) * BigInt(rateBps) + 5000n) / 10_000n,
  );
}

export interface PricedLine {
  lineTotalMinor: number;
  rateBps: number;
}

export function sumCommission(lines: PricedLine[]): number {
  return lines.reduce(
    (sum, line) => sum + commissionOf(line.lineTotalMinor, line.rateBps),
    0,
  );
}
