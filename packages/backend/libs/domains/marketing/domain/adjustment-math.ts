import { billable, type Billable } from './billing-math';

/** FR-051, AS-67: the difference that makes the net charged equal the exact amount; zero posts nothing. */
export const adjust = (
  exactBillableMinor: number,
  netBilledMinor: number,
): { deltaMinor: number } => ({
  deltaMinor: exactBillableMinor - netBilledMinor,
});

/** Adjustments of one (campaign, hour) are numbered 1, 2, 3 ... : the next free number. */
export const nextSequence = (existing: readonly number[]): number =>
  existing.length === 0 ? 1 : Math.max(...existing) + 1;

export interface ExactHour extends Billable {
  hour: string;
}

/**
 * FR-050, AS-61: the exact billable amounts of one UTC day, with the daily cap applied to the exact clicks in hour order
 * (the hours are `YYYY-MM-DDTHH`, which sort chronologically). The cap is computed on the recomputation, not copied from
 * what the stream path billed.
 */
export function exactDay(
  clicksByHour: readonly { hour: string; clicks: number }[],
  cpcMinor: number,
  dailyBudgetMinor: number,
): ExactHour[] {
  let earlier = 0;
  return [...clicksByHour]
    .sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0))
    .map(({ hour, clicks }) => {
      const result = billable(clicks, cpcMinor, dailyBudgetMinor, earlier);
      earlier += result.amountMinor;
      return { hour, ...result };
    });
}
