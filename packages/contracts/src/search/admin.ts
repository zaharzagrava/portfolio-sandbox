import { z } from 'zod';
import { digitsToInt } from './product-search';

/** S32 admin contracts (http-api.md, data-model.md SearchReindexRun, AS-77, AS-73). */
export const REINDEX_KINDS = ['REINDEX', 'ROLLBACK'] as const;
export const REINDEX_STATUSES = [
  'QUEUED',
  'BUILDING',
  'CATCHING_UP',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export const reindexKindSchema = z.enum(REINDEX_KINDS);
export const reindexStatusSchema = z.enum(REINDEX_STATUSES);
export type ReindexKind = z.infer<typeof reindexKindSchema>;
export type ReindexStatus = z.infer<typeof reindexStatusSchema>;

export const reindexRunSchema = z
  .object({
    runId: z.string().uuid(),
    kind: reindexKindSchema,
    status: reindexStatusSchema,
    mappingVersion: z.number().int(),
    embeddingModelVersion: z.string(),
    index: z.string().nullable(),
    previousIndex: z.string().nullable(),
    previousRetiresAt: z.string().nullable(),
    documents: z.number().int().nonnegative(),
    failureReason: z.string().nullable(),
    requestedBy: z.string().uuid(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type ReindexRun = z.infer<typeof reindexRunSchema>;

/** `202` body of POST reindex / rollback. */
export const reindexAcceptedSchema = z
  .object({
    runId: z.string().uuid(),
    kind: reindexKindSchema,
    status: z.literal('QUEUED'),
  })
  .strict();

export const reindexRunPageSchema = z
  .object({
    items: z.array(reindexRunSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const reindexListQuerySchema = z
  .object({
    limit: digitsToInt
      .refine((n) => n >= 1 && n <= 50, { message: 'must be 1..50' })
      .optional(),
    cursor: z.string().min(1).max(1_000).optional(),
  })
  .strict();

export const searchIndexStatusSchema = z
  .object({
    alias: z.string(),
    activeIndex: z.string(),
    previousIndex: z.string().nullable(),
    previousRetiresAt: z.string().nullable(),
    mappingVersion: z.number().int(),
    expectedMappingVersion: z.number().int(),
    outdated: z.boolean(),
    embeddingModelVersion: z.string(),
    documentCount: z.number().int().nonnegative(),
    embeddingPendingCount: z.number().int().nonnegative(),
    synonymsVersion: z.number().int(),
    projectionLagSeconds: z.number().nonnegative(),
    activeRun: z
      .object({ runId: z.string().uuid(), status: reindexStatusSchema })
      .strict()
      .nullable(),
    lastRun: z
      .object({
        runId: z.string().uuid(),
        kind: reindexKindSchema,
        status: reindexStatusSchema,
        finishedAt: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SearchIndexStatus = z.infer<typeof searchIndexStatusSchema>;

export const synonymsPutRequestSchema = z
  .object({
    rules: z.array(z.string()),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type SynonymsPutRequest = z.infer<typeof synonymsPutRequestSchema>;

export const synonymsSchema = z
  .object({
    version: z.number().int().positive(),
    rules: z.array(z.string()),
    updatedAt: z.string(),
    updatedBy: z.string().uuid().nullable(),
  })
  .strict();
export type Synonyms = z.infer<typeof synonymsSchema>;

export const synonymsPutResponseSchema = z
  .object({
    version: z.number().int().positive(),
    ruleCount: z.number().int().nonnegative(),
    updatedAt: z.string(),
    unchanged: z.boolean(),
  })
  .strict();

export const QUALITY_LIMITS = {
  days: { min: 1, max: 90, default: 7 },
  limit: { min: 1, max: 100, default: 50 },
} as const;

const ranged = (min: number, max: number, def: number) =>
  digitsToInt
    .refine((n) => n >= min && n <= max, { message: `must be ${min}..${max}` })
    .default(def);

export const searchQualityQuerySchema = z
  .object({
    days: ranged(
      QUALITY_LIMITS.days.min,
      QUALITY_LIMITS.days.max,
      QUALITY_LIMITS.days.default,
    ),
    limit: ranged(
      QUALITY_LIMITS.limit.min,
      QUALITY_LIMITS.limit.max,
      QUALITY_LIMITS.limit.default,
    ),
  })
  .strict();
export type SearchQualityQuery = z.infer<typeof searchQualityQuerySchema>;

export const searchQualityRowSchema = z
  .object({
    query: z.string(),
    searches: z.number().int().nonnegative(),
    ctr: z.number().min(0),
    mrr: z.number().min(0).max(1),
    zeroResultRate: z.number().min(0).max(1),
  })
  .strict();

/** The body wraps the rows in `rows` (the HTTP doc names only the row shape). */
export const searchQualityReportSchema = z
  .object({ rows: z.array(searchQualityRowSchema) })
  .strict();
export type SearchQualityReport = z.infer<typeof searchQualityReportSchema>;
