import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handlers (application/wake-delivery.service.ts, the unread reconciliation) so an app that only
// enqueues loads the declaration without the worker code.
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    /** S28: one job per delivery held beyond the queue delay (quiet hours); the worker re-checks it at wake time. */
    'notifications.wake-delivery': { deliveryId: string };
    /** S28: every 5 minutes, rebuilds the unread counters of users marked dirty. */
    'notifications.reconcile-unread': Record<string, never>;
  }
}

/** Retry budget of the S28 jobs (contracts/services.md "Jobs"). */
export const WAKE_DELIVERY_MAX_ATTEMPTS = 3;

declareJobType({
  name: 'notifications.wake-delivery',
  contract: z.object({ deliveryId: z.string().min(1).max(200) }).strict(),
  maxAttempts: WAKE_DELIVERY_MAX_ATTEMPTS,
});

declareJobType({
  name: 'notifications.reconcile-unread',
  contract: z.object({}).strict() as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
});
