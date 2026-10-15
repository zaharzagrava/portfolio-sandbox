import { splitByLargestRemainder } from './allocation';
import { roundHalfAwayFromZero, toSafeNumber } from './money';
import { utcDaysBetween } from './periods';

export interface ProrationInput {
  periodStart: Date;
  periodEnd: Date;
  changeAt: Date;
  /** What the customer paid for the full period on the OLD price (unit x quantity), integer minor units. */
  oldAmount: number;
  /** What the full period costs on the NEW price/quantity, integer minor units. */
  newAmount: number;
}

export interface ProrationLine {
  kind: 'PRORATION_CREDIT' | 'PRORATION_CHARGE';
  description: string;
  /** Minor units; negative for the credit line. */
  amount: number;
}

export interface Proration {
  lines: ProrationLine[];
  /** The exact net `(new - old) x remaining / total`, rounded once; the lines add up to it. */
  net: number;
  totalDays: number;
  remainingDays: number;
}

/**
 * Whole UTC calendar days (S17 FR-041): `total = date(end) - date(start)`, `remaining = clamp(date(end) -
 * date(changeAt), 0, total)`. The day of the change belongs to the new price.
 */
export function prorationDays(
  periodStart: Date,
  periodEnd: Date,
  changeAt: Date,
): { totalDays: number; remainingDays: number } {
  const totalDays = utcDaysBetween(periodStart, periodEnd);
  const remainingDays = Math.max(
    0,
    Math.min(totalDays, utcDaysBetween(changeAt, periodEnd)),
  );
  return { totalDays, remainingDays };
}

/**
 * Mid-cycle change (S17 FR-042, AS-63, AS-64): the net is the exact rational `(new - old) x remaining / total`
 * rounded ONCE, half away from zero; the credit and charge lines are its largest-remainder split (each the floor or
 * ceiling of its exact value, ties to the credit line). Integer arithmetic only; zero lines are omitted. With no
 * remaining day, or an empty period, there are no lines.
 */
export function prorate({
  periodStart,
  periodEnd,
  changeAt,
  oldAmount,
  newAmount,
}: ProrationInput): Proration {
  const { totalDays, remainingDays } = prorationDays(
    periodStart,
    periodEnd,
    changeAt,
  );
  if (totalDays <= 0 || remainingDays === 0)
    return { lines: [], net: 0, totalDays, remainingDays };

  const total = BigInt(totalDays);
  const remaining = BigInt(remainingDays);
  const old = BigInt(oldAmount);
  const next = BigInt(newAmount);
  const net = roundHalfAwayFromZero((next - old) * remaining, total);
  const [credit, charge] = splitByLargestRemainder(
    [-old * remaining, next * remaining],
    total,
    net,
  );
  const lines: ProrationLine[] = [
    {
      kind: 'PRORATION_CREDIT' as const,
      description: `Unused time on previous plan (${remainingDays}/${totalDays} days)`,
      amount: toSafeNumber(credit),
    },
    {
      kind: 'PRORATION_CHARGE' as const,
      description: `Remaining time on new plan (${remainingDays}/${totalDays} days)`,
      amount: toSafeNumber(charge),
    },
  ].filter((line) => line.amount !== 0);
  return { lines, net: toSafeNumber(net), totalDays, remainingDays };
}

/** Overage beyond the included quota, priced per 1,000 units, rounded up to whole blocks. */
export function overage(
  used: number,
  included: number,
  pricePer1000: number,
): { units: number; amount: number } {
  const units = Math.max(0, used - included);
  return { units, amount: Math.ceil(units / 1000) * pricePer1000 };
}
