import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handlers (infra/payment.jobs.ts) so a process that only enqueues loads the declarations
// without the worker code.
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'payments.charge': { paymentId: string; attempt: number };
    'payments.resolve-unknown': { paymentId: string };
    'payments.sweep-unknown': Record<string, never>;
    'payments.refund': { paymentId: string };
    'payments.cancel-intent': { paymentId: string };
  }
}

/** The use case owns the charge retry rule (6 attempts / 10 minutes): the job itself runs once. */
declareJobType({
  name: 'payments.charge',
  contract: z.object({
    paymentId: z.string().uuid(),
    attempt: z.number().int().nonnegative(),
  }),
  maxAttempts: 1,
});
declareJobType({
  name: 'payments.resolve-unknown',
  contract: z.object({ paymentId: z.string().uuid() }),
  maxAttempts: 1,
});
declareJobType({ name: 'payments.sweep-unknown', contract: z.object({}) });
declareJobType({
  name: 'payments.refund',
  contract: z.object({ paymentId: z.string().uuid() }),
  maxAttempts: 1,
});
/** Retried with the platform's backoff until the provider has answered. */
declareJobType({
  name: 'payments.cancel-intent',
  contract: z.object({ paymentId: z.string().uuid() }),
  maxAttempts: 12,
});
