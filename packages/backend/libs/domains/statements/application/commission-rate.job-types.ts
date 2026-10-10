import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handler (statements.jobs.ts) so an app that only enqueues loads the declaration, not the worker.
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'statements.retro-adjust': {
      shopKey: string;
      category: string;
      from: string;
      to: string | null;
      reason: string;
    };
  }
}

declareJobType({
  name: 'statements.retro-adjust',
  contract: z.object({
    shopKey: z.string(),
    category: z.string(),
    from: z.string(),
    to: z.string().nullable(),
    reason: z.string(),
  }),
});
