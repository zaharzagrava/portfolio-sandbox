import { z } from 'zod';

/**
 * S14 ledger and reconciliation HTTP contracts (specs/domains/S14-ledger-reconciliation/contracts/http.md).
 * Money fields end in `Minor` and are integers; a balance may be negative.
 */

export const ledgerCurrencySchema = z.literal('EUR');

export const ledgerJournalKinds = [
  'SALE',
  'REFUND',
  'SETTLEMENT',
  'SWEEP',
  'PAYOUT',
  'PAYOUT_REVERSAL',
  'AD_CHARGE',
  'ADJUSTMENT',
] as const;
export const ledgerJournalKindSchema = z.enum(ledgerJournalKinds);

export const ledgerSystemAccounts = [
  'PROVIDER_CLEARING',
  'MARKETPLACE_CLEARING',
  'PLATFORM_FEES',
  'PAYOUT_CLEARING',
  'PAYOUTS_SENT',
] as const;

export const reconciliationIssueKinds = [
  'MISSING_IN_LEDGER',
  'MISSING_AT_PROVIDER',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'DUPLICATE_AT_PROVIDER',
  'INVALID_PROVIDER_RECORD',
] as const;
export const reconciliationIssueKindSchema = z.enum(reconciliationIssueKinds);

export const reconciliationRunStatusSchema = z.enum([
  'RUNNING',
  'COMPLETED',
  'FAILED',
]);
export const reconciliationIssueStatusSchema = z.enum(['OPEN', 'RESOLVED']);
export const reconciliationResolutionSchema = z.enum([
  'explained',
  'adjusted',
  'auto_matched',
]);
export const reconciliationFailureCodeSchema = z.enum([
  'provider_unavailable',
  'interrupted',
  'internal',
]);

const isoDateTime = z.string().datetime({ offset: true });
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `GET /shops/:shopId/balance`. */
export const balanceSchema = z.object({
  shopId: z.string().uuid(),
  currency: ledgerCurrencySchema,
  availableMinor: z.number().int(),
  asOf: isoDateTime,
  source: z.enum(['read_model', 'ledger']),
});
export type Balance = z.infer<typeof balanceSchema>;

export const reconciliationRunSchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  day: calendarDay,
  status: reconciliationRunStatusSchema,
  providerLines: z.number().int().nonnegative(),
  ledgerJournals: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failureCode: reconciliationFailureCodeSchema.nullable(),
  startedAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
});
export type ReconciliationRun = z.infer<typeof reconciliationRunSchema>;

export const reconciliationRunPageSchema = z.object({
  items: z.array(reconciliationRunSchema),
  nextCursor: z.string().nullable(),
});

export const reconciliationIssueSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  day: calendarDay,
  kind: reconciliationIssueKindSchema,
  reference: z.string(),
  details: z.record(z.string(), z.unknown()),
  status: reconciliationIssueStatusSchema,
  resolution: reconciliationResolutionSchema.nullable(),
  note: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: isoDateTime.nullable(),
  adjustmentJournalId: z.string().uuid().nullable(),
  createdAt: isoDateTime,
});
export type ReconciliationIssue = z.infer<typeof reconciliationIssueSchema>;

export const reconciliationIssuePageSchema = z.object({
  items: z.array(reconciliationIssueSchema),
  nextCursor: z.string().nullable(),
});

/** `POST /finance/reconciliation/issues/:issueId/resolve` (strict: an unknown property is a `400`). */
export const resolveReconciliationIssueRequestSchema = z
  .object({
    resolution: z.enum(['explained', 'adjusted']),
    note: z.string().min(1).max(500),
    adjustment: z
      .object({
        currency: ledgerCurrencySchema,
        lines: z
          .array(
            z
              .object({
                accountId: z.string().min(1).max(255),
                amountMinor: z
                  .number()
                  .int()
                  .refine((n) => n !== 0, 'amountMinor must not be zero'),
              })
              .strict(),
          )
          .min(2)
          .max(10),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ResolveReconciliationIssueRequest = z.infer<
  typeof resolveReconciliationIssueRequestSchema
>;
