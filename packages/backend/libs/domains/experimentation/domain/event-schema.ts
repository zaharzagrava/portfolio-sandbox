import {
  readEnvelope,
  toStoredMessage,
  validateIngestBatch,
  validateIngestEvent,
  type AcceptedEvent,
  type IngestBatchResult,
  type IngestVerdict,
  type StoredEventMessage,
} from '@marketplace-sandbox/contracts';

/**
 * The client event rules live in `packages/contracts/src/analytics/ingest-rules.ts` (one file for the fallback and the
 * edge worker, pinned by `ingest-vectors.json`). This module is the domain's seam to them: the clock is never read here,
 * `now` always comes from the caller.
 */
export const ANALYTICS_TOPIC = 'analytics.events';

export type StoredEvent = StoredEventMessage;
export type { AcceptedEvent, IngestBatchResult, IngestVerdict };

export { readEnvelope };

export const judgeEvent = (raw: unknown, now: number): IngestVerdict =>
  validateIngestEvent(raw, { now });

export const judgeEvents = (
  events: readonly unknown[],
  now: number,
): IngestBatchResult => validateIngestBatch(events, { now });

export const enrichEvent = (
  event: AcceptedEvent,
  meta: { userId?: string; country?: string; platform?: string },
): StoredEvent => toStoredMessage(event, meta);
