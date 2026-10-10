import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Payload types and contracts of the search jobs, apart from the handlers so a caller that only enqueues (the admin
// routes) loads the declaration without the job code. Callers catch `InvalidScheduleError` (S49).
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'search.reindex': { runId: string };
    'search.retire-previous-index': Record<string, never>;
    'search.refresh-popularity': Record<string, never>;
    'search.backfill-shop-state': { cursor?: string };
    'search.backfill-embeddings': Record<string, never>;
    'search.purge-tombstones': Record<string, never>;
  }
}

declareJobType({
  name: 'search.reindex',
  contract: z.object({ runId: z.string().uuid() }).strict(),
});
declareJobType({
  name: 'search.retire-previous-index',
  contract: z.object({}).strict(),
});
declareJobType({
  name: 'search.refresh-popularity',
  contract: z.object({}).strict(),
});
declareJobType({
  name: 'search.backfill-shop-state',
  contract: z.object({ cursor: z.string().uuid().optional() }).strict(),
});
declareJobType({
  name: 'search.backfill-embeddings',
  contract: z.object({}).strict(),
});
declareJobType({
  name: 'search.purge-tombstones',
  contract: z.object({}).strict(),
});
