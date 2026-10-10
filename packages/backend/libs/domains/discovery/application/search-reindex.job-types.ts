import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handler (search-reindex.service.ts) so the admin controller, which only enqueues, loads the
// declaration without the reindexer.
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'search.reindex-products': { batchSize?: number };
  }
}

declareJobType({
  name: 'search.reindex-products',
  contract: z.object({ batchSize: z.number().optional() }),
});
