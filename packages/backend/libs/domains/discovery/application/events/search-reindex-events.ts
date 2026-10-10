import { searchReindexCompletedPayloadSchema } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * `search.reindex_completed` v1 on `search.events`, keyed by `runId`, appended to the outbox in the transaction that
 * records the run `COMPLETED` (S32 FR-036): it exists if and only if the run completed.
 */
export const SearchReindexCompleted = defineEvent(
  'search.reindex_completed',
  'search',
  1,
  searchReindexCompletedPayloadSchema,
);
