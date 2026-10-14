import { z } from 'zod';

/**
 * S39 experiments (specs/domains/S39-analytics-ab/contracts/experiments-api.md). Shape errors (types, key patterns,
 * unknown fields) are answered `400` from `experimentWriteSchema`; the meaning of a definition (weights summing to
 * 10,000, ranges, metric and unit) is checked by the domain and answered `422` with every problem at once, so the
 * write schema lets those values through as plain numbers and strings.
 */

export const EXPERIMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const EXPERIMENT_VARIANT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const EXPERIMENT_LAYER_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const EXPERIMENT_UNITS = ['user', 'visitor'] as const;
export const EXPERIMENT_STATUSES = ['draft', 'running', 'stopped'] as const;
export const EXPERIMENT_ACTIONS = ['create', 'update', 'start', 'stop'] as const;
export const EXPERIMENT_METRICS = [
  'page_view',
  'product_view',
  'search',
  'add_to_cart',
  'checkout_step',
  'click',
  'video_view',
  'purchase',
] as const;
export const EXPERIMENT_BUCKETS = 10_000;

export const EXPERIMENT_LIMITS = {
  experiments: 200,
  variants: 10,
  minVariants: 2,
  description: 500,
  owner: 100,
} as const;

/** `errors[].code` of an `experiment_definition_invalid` answer. */
export const EXPERIMENT_DEFINITION_ERROR_CODES = [
  'variants_count',
  'variant_key_invalid',
  'variant_key_duplicate',
  'weight_invalid',
  'weights_sum',
  'layer_range_invalid',
  'layer_invalid',
  'metric_unknown',
  'metric_unit_mismatch',
  'owner_required',
] as const;
export type ExperimentDefinitionErrorCode =
  (typeof EXPERIMENT_DEFINITION_ERROR_CODES)[number];

export const EXPERIMENT_PROBLEM_CODES = [
  'validation_failed',
  'not_found',
  'version_conflict',
  'experiment_immutable',
  'experiment_definition_invalid',
  'experiment_limit_reached',
  'illegal_transition',
  'layer_range_conflict',
  'invalid_cursor',
  'analytics_store_unavailable',
  'rate_limited',
] as const;
export type ExperimentProblemCode = (typeof EXPERIMENT_PROBLEM_CODES)[number];

export const EXPERIMENT_RESULT_PROBLEMS = [
  'srm_mismatch',
  'crossover_exceeds_threshold',
] as const;
export const EXPERIMENT_COMPARISONS = [
  'control',
  'available',
  'insufficient_sample',
  'withheld_untrustworthy',
  'no_data',
] as const;

/** Header the browser sends so a visitor experiment can assign without a session. */
export const ANONYMOUS_ID_HEADER = 'x-anonymous-id';

// ---- assignments ----

export const assignmentsResponseSchema = z.object({
  assignments: z.record(z.string(), z.object({ variant: z.string() })),
  degraded: z.boolean(),
});
export type AssignmentsResponse = z.infer<typeof assignmentsResponseSchema>;

// ---- write ----

const variantWriteSchema = z.strictObject({
  key: z.string(),
  weight: z.number(),
});

export const experimentWriteSchema = z.strictObject({
  expectedVersion: z.number().int().min(0),
  description: z.string().max(EXPERIMENT_LIMITS.description).optional(),
  owner: z.string().max(EXPERIMENT_LIMITS.owner),
  unit: z.enum(EXPERIMENT_UNITS).optional(),
  variants: z.array(variantWriteSchema).max(64),
  layer: z.string().max(64),
  layerFrom: z.number(),
  layerTo: z.number(),
  metric: z.string().max(64),
});
export type ExperimentWrite = z.infer<typeof experimentWriteSchema>;

// ---- read ----

const variantSchema = z.object({
  key: z.string(),
  weight: z.number().int(),
});

export const experimentSchema = z.object({
  key: z.string(),
  description: z.string(),
  owner: z.string(),
  unit: z.enum(EXPERIMENT_UNITS),
  status: z.enum(EXPERIMENT_STATUSES),
  variants: z.array(variantSchema),
  layer: z.string(),
  layerFrom: z.number().int(),
  layerTo: z.number().int(),
  metric: z.string(),
  version: z.number().int(),
  startedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  startedBy: z.string().nullable(),
  stoppedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Experiment = z.infer<typeof experimentSchema>;

export const experimentPageSchema = z.object({
  items: z.array(experimentSchema),
  nextCursor: z.string().nullable(),
});
export type ExperimentPage = z.infer<typeof experimentPageSchema>;

export const experimentHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  action: z.enum(EXPERIMENT_ACTIONS),
  actorId: z.string().min(1),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()),
  requestId: z.string().nullable(),
  at: z.string(),
});
export type ExperimentHistoryEntry = z.infer<typeof experimentHistoryEntrySchema>;

export const experimentHistoryPageSchema = z.object({
  items: z.array(experimentHistoryEntrySchema),
  nextCursor: z.string().nullable(),
});
export type ExperimentHistoryPage = z.infer<typeof experimentHistoryPageSchema>;

// ---- results ----

const vsControlSchema = z.object({
  absoluteDifference: z.number(),
  relativeLift: z.number().nullable(),
  zScore: z.number(),
  pValue: z.number(),
  confidenceInterval95: z.tuple([z.number(), z.number()]),
  significant: z.boolean(),
});

export const experimentResultsSchema = z.object({
  experiment: z.string(),
  version: z.number().int(),
  status: z.enum(EXPERIMENT_STATUSES),
  metric: z.string(),
  unit: z.enum(EXPERIMENT_UNITS),
  analysis: z.literal('fixed_horizon'),
  windowStart: z.string().nullable(),
  windowEnd: z.string(),
  asOf: z.string(),
  alpha: z.number(),
  trustworthy: z.boolean(),
  problems: z.array(z.enum(EXPERIMENT_RESULT_PROBLEMS)),
  srm: z.object({
    chiSquare: z.number(),
    pValue: z.number(),
    mismatch: z.boolean(),
  }),
  excluded: z.object({
    unattributable: z.number().int(),
    unknownVariant: z.number().int(),
    crossoverUnits: z.number().int(),
  }),
  variants: z.array(
    z.object({
      variant: z.string(),
      exposures: z.number().int(),
      conversions: z.number().int(),
      conversionRate: z.number(),
      comparison: z.enum(EXPERIMENT_COMPARISONS),
      vsControl: vsControlSchema.optional(),
    }),
  ),
});
export type ExperimentResults = z.infer<typeof experimentResultsSchema>;
