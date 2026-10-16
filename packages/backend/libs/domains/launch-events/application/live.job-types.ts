import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handlers (infra/jobs) so an app that only enqueues loads the declarations without the worker code.
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    /** Every 30 s: rebuilds the active-stream set and the mute cache from the durable records. */
    'launch-events.live-reconcile': Record<string, never>;
  }
}

declareJobType({
  name: 'launch-events.live-reconcile',
  contract: z.object({}).strict(),
});
