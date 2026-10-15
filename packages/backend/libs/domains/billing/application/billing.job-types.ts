import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handlers (infra/billing.jobs.ts) so an app that only enqueues loads the declarations, not the
// workers. Payload contracts: specs/domains/S17-subscriptions/contracts/jobs.md.
export const runPayloadSchema = z.strictObject({});
export const chargeInvoicePayloadSchema = z.strictObject({
  invoiceId: z.string().uuid(),
});
/**
 * `attempt` is the attempt reference: `1`..`4` for a numbered attempt, `manual:<k>` for an extra one. `round` counts
 * the resolutions already tried (0 for the first) and drives the backoff.
 */
export const resolveAttemptPayloadSchema = z.strictObject({
  invoiceId: z.string().uuid(),
  attempt: z.string().regex(/^([1-4]|manual:[1-9][0-9]{0,5})$/),
  round: z.number().int().min(0).max(1000).optional(),
});
export const manualAttemptPayloadSchema = z.strictObject({
  invoiceId: z.string().uuid(),
  k: z.number().int().min(1).max(100_000),
});
/** S18: the daily check of the usage settlement ledger (report only). */
export const usageReconcilePayloadSchema = z.strictObject({});

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'billing.run': z.infer<typeof runPayloadSchema>;
    'billing.charge-invoice': z.infer<typeof chargeInvoicePayloadSchema>;
    'billing.resolve-attempt': z.infer<typeof resolveAttemptPayloadSchema>;
    'billing.manual-attempt': z.infer<typeof manualAttemptPayloadSchema>;
    'billing.usage-reconcile': z.infer<typeof usageReconcilePayloadSchema>;
  }
}

declareJobType({ name: 'billing.run', contract: runPayloadSchema });
// 3 attempts for infrastructure errors only: a provider outcome is never a job error (it is settled or resolved).
declareJobType({
  name: 'billing.charge-invoice',
  contract: chargeInvoicePayloadSchema,
  maxAttempts: 3,
});
declareJobType({
  name: 'billing.resolve-attempt',
  contract: resolveAttemptPayloadSchema,
});
declareJobType({
  name: 'billing.manual-attempt',
  contract: manualAttemptPayloadSchema,
  maxAttempts: 3,
});
declareJobType({
  name: 'billing.usage-reconcile',
  contract: usageReconcilePayloadSchema,
});
