import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

/** Both jobs take no payload: an unknown field is a malformed schedule (`InvalidScheduleError`), not a silently ignored one. */
const empty = z.strictObject({});

// Kept apart from the handlers (infra/chat.jobs.ts) so an app that only enqueues loads the declarations without the
// worker code (S49 follow-up: every job type has a payload contract next to the `JobPayloads` augmentation).
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'chat.partition-maintenance': Record<string, never>;
    'chat.backfill-shops': Record<string, never>;
  }
}

declareJobType({ name: 'chat.partition-maintenance', contract: empty });
declareJobType({ name: 'chat.backfill-shops', contract: empty });

export const chatJobPayloadSchema = empty;
