import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handler (infra/onboarding.jobs.ts) so an app that only enqueues loads the declaration without
// the worker code.
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'onboarding.purge-documents': { shopId: string };
  }
}

declareJobType({
  name: 'onboarding.purge-documents',
  contract: z.object({ shopId: z.string() }),
});
