export interface Billable {
  billableClicks: number;
  cappedClicks: number;
  amountMinor: number;
}

/**
 * FR-042, AS-57: whole clicks only. `billableClicks = max(0, min(clicks, floor((budget - billedEarlierToday) / cpc)))`,
 * `amount = billableClicks x cpc`, so a charge never exceeds the budget remaining and never includes a fraction of a
 * click. All integers: the largest product (10,000,000 minor units) is far below 2^53.
 */
export function billable(
  clicks: number,
  cpcMinor: number,
  dailyBudgetMinor: number,
  billedEarlierTodayMinor: number,
): Billable {
  if (
    !Number.isSafeInteger(clicks) ||
    clicks < 0 ||
    !Number.isSafeInteger(cpcMinor) ||
    cpcMinor < 1 ||
    !Number.isSafeInteger(dailyBudgetMinor) ||
    !Number.isSafeInteger(billedEarlierTodayMinor)
  )
    throw new RangeError('clicks and money must be whole numbers, cpc >= 1');
  const affordable = Math.floor(
    (dailyBudgetMinor - billedEarlierTodayMinor) / cpcMinor,
  );
  const billableClicks = Math.max(0, Math.min(clicks, affordable));
  return {
    billableClicks,
    cappedClicks: clicks - billableClicks,
    amountMinor: billableClicks * cpcMinor,
  };
}
