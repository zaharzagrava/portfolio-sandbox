import { DateTime } from 'luxon';

export type BillingInterval = 'MONTH' | 'YEAR';

/**
 * Next period end for a subscription anchored on `anchorDay` (lesson 10/07 #24
 * "billing on the 31st → shorter months"): the anchor is clamped to the
 * month's length (31 → Feb 28/29 → Mar 31), and the ORIGINAL anchor is kept,
 * so a subscription started on Jan 31 bills Feb 28, then Mar 31 - not Mar 28
 * forever. All in UTC.
 */
export function addPeriod(
  from: Date,
  interval: BillingInterval,
  anchorDay: number,
): Date {
  const start = DateTime.fromJSDate(from, { zone: 'utc' });
  const target =
    interval === 'MONTH' ? start.plus({ months: 1 }) : start.plus({ years: 1 });
  const day = Math.min(anchorDay, target.daysInMonth);
  return target.set({ day }).toJSDate();
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}
