import { z } from 'zod';
import {
  ledgerJournalKindSchema,
  reconciliationIssueKindSchema,
  reconciliationRunStatusSchema,
} from './ledger.ts';

/**
 * S14 `ledger.events` (specs/domains/S14-ledger-reconciliation/contracts/events.md). Ids, references and amounts only:
 * no personal data. `journal_posted` v2 replaces v1 (deltas without balances); `lines` may be empty only on a v1
 * payload lifted by the consumer's upcast, never on a posted journal.
 */
export const journalPostedV2Schema = z.object({
  journalId: z.string().uuid(),
  kind: ledgerJournalKindSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  postedAt: z.string().datetime({ offset: true }),
  lines: z.array(
    z.object({
      accountId: z.string(),
      shard: z.number().int().nonnegative(),
      amountMinor: z.number().int(),
      balanceAfterMinor: z.number().int(),
      balanceVersion: z.number().int().nonnegative(),
    }),
  ),
  paymentId: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
});
export type JournalPostedV2 = z.infer<typeof journalPostedV2Schema>;

export const reconciliationCompletedSchema = z.object({
  runId: z.string().uuid(),
  provider: z.string(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: reconciliationRunStatusSchema,
  matched: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
});

export const reconciliationIssueOpenedSchema = z.object({
  issueId: z.string().uuid(),
  runId: z.string().uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: reconciliationIssueKindSchema,
  reference: z.string(),
});

export const ledgerEventSchemas = {
  'ledger.journal_posted': journalPostedV2Schema,
  'ledger.reconciliation_completed': reconciliationCompletedSchema,
  'ledger.reconciliation_issue_opened': reconciliationIssueOpenedSchema,
} as const;
