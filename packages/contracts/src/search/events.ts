import { z } from 'zod';
import { searchModeSchema } from './product-search';
import { reindexKindSchema } from './admin';

/**
 * `search.events` v1 (contracts/events-and-ports.md, AS-76). `searchEventSchemas` are the full wire events (envelope
 * `{eventId, type, version: 1, occurredAt, aggregateId, payload}`) keyed by type; `searchEventPayloadSchemas` are the
 * payloads alone (what the outbox/publisher takes next to the envelope fields).
 */
export const searchPerformedPayloadSchema = z
  .object({
    searchId: z.string().min(1),
    query: z.string(),
    results: z.number().int().nonnegative(),
    mode: searchModeSchema,
    userHash: z.string(),
    filters: z.array(z.string()),
    degraded: z.array(z.string()),
    surface: z.enum(['http', 'internal']),
  })
  .strict();

export const searchResultClickedPayloadSchema = z
  .object({
    searchId: z.string().min(1),
    query: z.string(),
    productId: z.string().uuid(),
    position: z.number().int().min(0).max(99),
  })
  .strict();

export const searchReindexCompletedPayloadSchema = z
  .object({
    runId: z.string().uuid(),
    kind: reindexKindSchema,
    index: z.string(),
    previousIndex: z.string().nullable(),
    documents: z.number().int().nonnegative(),
    mappingVersion: z.number().int(),
    finishedAt: z.string(),
  })
  .strict();

export const searchEventPayloadSchemas = {
  'search.performed': searchPerformedPayloadSchema,
  'search.result_clicked': searchResultClickedPayloadSchema,
  'search.reindex_completed': searchReindexCompletedPayloadSchema,
} as const;

const envelope = {
  eventId: z.string().min(1),
  version: z.literal(1),
  occurredAt: z.iso.datetime(),
  aggregateId: z.string().min(1),
};

export const searchEventSchemas = {
  'search.performed': z
    .object({
      ...envelope,
      type: z.literal('search.performed'),
      payload: searchPerformedPayloadSchema,
    })
    .strict(),
  'search.result_clicked': z
    .object({
      ...envelope,
      type: z.literal('search.result_clicked'),
      payload: searchResultClickedPayloadSchema,
    })
    .strict(),
  'search.reindex_completed': z
    .object({
      ...envelope,
      type: z.literal('search.reindex_completed'),
      payload: searchReindexCompletedPayloadSchema,
    })
    .strict(),
} as const;

export type SearchEventType = keyof typeof searchEventSchemas;
export type SearchPerformedEvent = z.infer<
  (typeof searchEventSchemas)['search.performed']
>;
export type SearchResultClickedEvent = z.infer<
  (typeof searchEventSchemas)['search.result_clicked']
>;
export type SearchReindexCompletedEvent = z.infer<
  (typeof searchEventSchemas)['search.reindex_completed']
>;
