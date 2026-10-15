import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handlers (infra/statements.jobs.ts) so an app that only enqueues loads the declarations, not
// the workers. Payload contracts: specs/domains/S16-seller-statements/contracts/jobs.md.
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const closeMonthPayloadSchema = z.strictObject({
  month: month.optional(),
  runId: z.string().uuid().optional(),
});

/** `rate_change:<changeId>`, `late_sale:<orderId>`, `late_payout:<payoutId>` or `close:<runId>`. */
export const reconcileCauseSchema = z
  .string()
  .regex(/^(rate_change|late_sale|late_payout|close):.{1,200}$/);

export const reconcileMonthPayloadSchema = z.strictObject({
  month,
  cause: reconcileCauseSchema,
  shopId: z.string().uuid().optional(),
});

export const verifyPeriodPayloadSchema = z.strictObject({ month });

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'statements.close-month': z.infer<typeof closeMonthPayloadSchema>;
    'statements.reconcile-month': z.infer<typeof reconcileMonthPayloadSchema>;
    'statements.verify-period': z.infer<typeof verifyPeriodPayloadSchema>;
    'statements.verify-periods': Record<string, never>;
  }
}

declareJobType({
  name: 'statements.close-month',
  contract: closeMonthPayloadSchema,
});
declareJobType({
  name: 'statements.reconcile-month',
  contract: reconcileMonthPayloadSchema,
});
declareJobType({
  name: 'statements.verify-period',
  contract: verifyPeriodPayloadSchema,
});
declareJobType({
  name: 'statements.verify-periods',
  contract: z.strictObject({}),
});
