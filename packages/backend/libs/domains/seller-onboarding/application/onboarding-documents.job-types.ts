import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handlers (infra/onboarding.jobs.ts) so an app that only enqueues loads the declarations without
// the worker code.
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'onboarding.purge-documents': { shopId: string; submissionNo: number };
    'onboarding.erase-records': { shopId: string };
  }
}

declareJobType({
  name: 'onboarding.purge-documents',
  contract: z.object({
    shopId: z.string().uuid(),
    // jobs queued before rounds existed carry only the shop: they belong to round 1
    submissionNo: z.number().int().min(1).default(1),
  }),
});

declareJobType({
  name: 'onboarding.erase-records',
  contract: z.object({ shopId: z.string().uuid() }),
});
