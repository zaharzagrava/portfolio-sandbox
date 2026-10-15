export type BillingInterval = 'MONTH' | 'YEAR';

export const DAY_MS = 86_400_000;

/**
 * Next period end for a subscription anchored on `anchorDay` (S17 FR-025, pattern P0104): calendar months or years in
 * UTC, the anchor clamped to the target month's length and restored afterwards, so a subscription started on Jan 31
 * ends Feb 28, then Mar 31, never "the 28th forever". The time of day is kept. Independent of the server time zone.
 */
export function addPeriod(
  from: Date,
  interval: BillingInterval,
  anchorDay: number,
): Date {
  const monthIndex =
    from.getUTCFullYear() * 12 +
    from.getUTCMonth() +
    (interval === 'MONTH' ? 1 : 12);
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(from.getTime());
  result.setUTCFullYear(year, month, Math.min(anchorDay, daysInMonth));
  return result;
}

/** Whole days since 1970-01-01 of the UTC calendar date of `instant` (the time of day is dropped). */
export function utcDayNumber(instant: Date): number {
  return Math.floor(instant.getTime() / DAY_MS);
}

/** `date(b) - date(a)` in whole UTC calendar days. */
export function utcDaysBetween(a: Date, b: Date): number {
  return utcDayNumber(b) - utcDayNumber(a);
}
