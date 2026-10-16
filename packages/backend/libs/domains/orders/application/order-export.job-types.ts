import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handlers (infra/order-export.jobs.ts) so an app that only enqueues loads the declarations without
// the worker code (S49: every job type carries a payload contract, or enqueue and upsertSchedule refuse it).
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'orders.recover-stalled-exports': Record<string, never>;
    'orders.expire-exports': Record<string, never>;
    'orders.purge-exports': Record<string, never>;
  }
}

declareJobType({
  name: 'orders.recover-stalled-exports',
  contract: z.object({}).strict(),
});
declareJobType({
  name: 'orders.expire-exports',
  contract: z.object({}).strict(),
});
declareJobType({
  name: 'orders.purge-exports',
  contract: z.object({}).strict(),
});
