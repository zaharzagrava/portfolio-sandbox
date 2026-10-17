import { draftPublishedPayloadSchema } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * `drafts.events` (key = draftId): written inside the publish transaction, next to the product's own event. Nobody
 * consumes it yet. A draft is published at most once, so its aggregate version is 1.
 */
export const DraftPublished = defineEvent(
  'catalog.draft_published',
  'drafts',
  1,
  draftPublishedPayloadSchema,
  { carries: 'delta' },
);

export const DRAFTS_AGGREGATE: TopicRegistration = {
  aggregateType: 'drafts',
  retention: 'full-history',
};
