import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handlers (infra/payout.jobs.ts) so a process that only enqueues loads the declarations without
// the worker code (S49 follow-up: every job type declares its payload contract next to the augmentation).
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'payouts.run-weekly': { periodStart?: string };
    'payouts.send': { payoutId: string };
    'payouts.resolve-in-doubt': Record<string, never>;
    'payouts.audit-daily': { day?: string };
  }
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

declareJobType({
  name: 'payouts.run-weekly',
  contract: z.object({ periodStart: day.optional() }).strict(),
  maxAttempts: 3,
});
declareJobType({
  name: 'payouts.send',
  contract: z.object({ payoutId: z.string().uuid() }).strict(),
  maxAttempts: 5,
});
declareJobType({
  name: 'payouts.resolve-in-doubt',
  contract: z.object({}).strict() as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
});
declareJobType({
  name: 'payouts.audit-daily',
  contract: z.object({ day: day.optional() }).strict(),
  maxAttempts: 3,
});
