/**
 * Monthly history partitions of `ChatMessage` (S24 FR-024, P0318). Months are UTC `YYYY-MM`. Pure.
 */
export const PARTITION_MONTHS_AHEAD = 3;

const pad = (n: number) => String(n).padStart(2, '0');
const monthOf = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
const label = (index: number) =>
  `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;

/** Every month from the oldest message's (or the current when there is none) to the current + `ahead`. */
export function partitionMonths(
  oldest: Date | null,
  now: Date,
  ahead: number = PARTITION_MONTHS_AHEAD,
): string[] {
  const current = monthOf(now);
  const first = oldest ? Math.min(monthOf(oldest), current) : current;
  const out: string[] = [];
  for (let m = first; m <= current + ahead; m++) out.push(label(m));
  return out;
}

export const monthPartitionName = (month: string): string =>
  `ChatMessage_${month.replace('-', '_')}`;

/** Half-open range `[from, to)` of a month, as ISO instants. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  return {
    from: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    to: new Date(Date.UTC(y, m, 1)).toISOString(),
  };
}
