import { z } from 'zod';

/**
 * S15 `payouts.events` (specs/domains/S15-payouts/contracts/events.md): key = `payoutId`, money ends in `Minor`.
 * Ids, amounts and codes only: no destination, no provider account id, no secret, no provider body. Every schema is
 * strict, so a producer that adds a field has to change the contract first. `payoutVersion` is the row version after
 * the update: monotone, not contiguous (consumers discard `<= last seen`).
 */
const id = z.string().uuid();
const period = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().datetime({ offset: true });
const minor = z.number().int().positive();

const payoutBase = {
  payoutId: id,
  shopId: id,
  periodStart: period,
  amountMinor: minor,
  currency: z.string().regex(/^[A-Z]{3}$/),
  payoutVersion: z.number().int().positive(),
};

export const payoutCreatedSchema = z.strictObject({
  ...payoutBase,
  reserveHeldMinor: z.number().int().nonnegative(),
});

export const payoutPaidSchema = z.strictObject({
  ...payoutBase,
  transferRef: z.string().min(1),
  paidAt: instant,
});

export const payoutFailedSchema = z.strictObject({
  ...payoutBase,
  failureCode: z.string().min(1),
});

export const payoutCancelledSchema = z.strictObject({
  ...payoutBase,
  cancelledBy: z.string().min(1),
  reason: z.string().min(1).max(200),
});

export const payoutInDoubtSchema = z.strictObject({
  ...payoutBase,
  inDoubtSince: instant,
});

export const payoutDiscrepancyKinds = [
  'amount',
  'currency',
  'destination',
  'missing_transfer',
  'reversed_at_provider',
  'conflicting_outcome',
] as const;
export const payoutDiscrepancyKindSchema = z.enum(payoutDiscrepancyKinds);
export type PayoutDiscrepancyKind = z.infer<typeof payoutDiscrepancyKindSchema>;

export const payoutDiscrepancyDetectedSchema = z.strictObject({
  payoutId: id,
  shopId: id,
  kind: payoutDiscrepancyKindSchema,
  payoutVersion: z.number().int().positive(),
});

export const payoutEventSchemas = {
  'payout.created': payoutCreatedSchema,
  'payout.paid': payoutPaidSchema,
  'payout.failed': payoutFailedSchema,
  'payout.cancelled': payoutCancelledSchema,
  'payout.in_doubt': payoutInDoubtSchema,
  'payout.discrepancy_detected': payoutDiscrepancyDetectedSchema,
} as const;

export type PayoutEventType = keyof typeof payoutEventSchemas;
