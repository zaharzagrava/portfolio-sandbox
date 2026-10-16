import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handlers (infra/assets.jobs.ts) so an app that only enqueues loads the declarations without the
// worker code. All four are scheduled, carry no payload and are idempotent (S31 FR-050).
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'assets.gc-chunks': Record<string, never>;
    'assets.purge-deleted-assets': Record<string, never>;
    'assets.purge-download-grants': Record<string, never>;
    'assets.purge-changes': Record<string, never>;
  }
}

for (const name of [
  'assets.gc-chunks',
  'assets.purge-deleted-assets',
  'assets.purge-download-grants',
  'assets.purge-changes',
] as const)
  declareJobType({ name, contract: z.object({}) });
