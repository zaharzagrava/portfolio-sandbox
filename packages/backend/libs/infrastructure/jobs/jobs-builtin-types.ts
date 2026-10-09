import { z } from 'zod';
import { declareJobType } from './job-type-registry';

/** Job types owned by this lib; imported by every file that enqueues or handles them. */
declareJobType({
  name: 'jobs.partition-maintenance',
  contract: z.object({
    aheadDays: z.number().int().min(1).max(60).optional(),
    retainDays: z.number().int().min(1).max(3650).optional(),
  }),
  maxAttempts: 3,
});

declareJobType({ name: 'jobs.noop', contract: z.object({}) });
