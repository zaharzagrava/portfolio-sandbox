import { daysBetween } from './periods';

export interface ProrationInput {
  periodStart: Date;
  periodEnd: Date;
  changeAt: Date;
  /** What the customer paid for the full period on the OLD price (unit × quantity). */
  oldAmount: number;
  /** What the full period costs on the NEW price/quantity. */
  newAmount: number;
}

export interface ProrationLine {
  kind: 'PRORATION_CREDIT' | 'PRORATION_CHARGE';
  description: string;
  amount: number;
}

/**
 * Mid-cycle change (upgrade, downgrade, seats): credit the unused part of the
 * old price, charge the remaining part of the new one, both computed on the
 * same day boundary so they're consistent. Rounding: half away from zero per
 * line, documented, so an invoice can be recomputed bit-for-bit (audits).
 */
export function prorate({
  periodStart,
  periodEnd,
  changeAt,
  oldAmount,
  newAmount,
}: ProrationInput): ProrationLine[] {
  const total = daysBetween(periodStart, periodEnd);
  const remaining = Math.max(
    0,
    Math.min(total, daysBetween(changeAt, periodEnd)),
  );
  if (total <= 0 || remaining === 0) return [];

  const credit = roundHalfAwayFromZero((oldAmount * remaining) / total);
  const charge = roundHalfAwayFromZero((newAmount * remaining) / total);
  return [
    {
      kind: 'PRORATION_CREDIT' as const,
      description: `Unused time on previous plan (${remaining}/${total} days)`,
      amount: -credit,
    },
    {
      kind: 'PRORATION_CHARGE' as const,
      description: `Remaining time on new plan (${remaining}/${total} days)`,
      amount: charge,
    },
  ].filter((l) => l.amount !== 0);
}

export function roundHalfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
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
