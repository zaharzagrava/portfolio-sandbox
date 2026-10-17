import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'shop-functions.recover-stuck-versions': Record<string, never>;
  }
}

export const RECOVER_STUCK_JOB = 'shop-functions.recover-stuck-versions';
export const RECOVER_STUCK_SCHEDULE = 'shop-functions.recover-stuck-versions';

declareJobType({ name: RECOVER_STUCK_JOB, contract: z.object({}).strict() });
