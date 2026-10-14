import { z } from 'zod';
import { INGEST_CODES, INGEST_LIMITS } from './ingest-rules.ts';

/**
 * S39 ingest contract (specs/domains/S39-analytics-ab/contracts/ingest-api.md). The request schema only describes the
 * envelope: each event is judged on its own by `validateIngestEvent`, so one bad event never fails the batch.
 */
export const ingestRequestSchema = z.object({
  events: z.array(z.unknown()).min(1).max(INGEST_LIMITS.events),
});
export type IngestRequest = z.infer<typeof ingestRequestSchema>;

export const ingestCodeSchema = z.enum(INGEST_CODES);

/** `202` body of `POST /api/events` and `POST /collect`: what was accepted and, by input index, why the rest was not. */
export const ingestResultSchema = z.object({
  accepted: z.number().int().min(0),
  rejected: z.array(
    z.object({ index: z.number().int().min(0), code: ingestCodeSchema }),
  ),
});
export type IngestResult = z.infer<typeof ingestResultSchema>;

/** Codes of the problem+json answers of the ingest routes. */
export const INGEST_PROBLEM_CODES = [
  'validation_failed',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'ingest_unavailable',
] as const;
export type IngestProblemCode = (typeof INGEST_PROBLEM_CODES)[number];
