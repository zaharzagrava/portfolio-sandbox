import {
  flagChangedEventSchema,
  flagChangedPayloadSchema,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * The `flags` aggregate owns the standard topic `flags.events` (key = flag key). Flag changes are rare, so the default
 * partition count is plenty. Only a standard topic: no `groupId` or other FIFO option ever goes with these events (L-001).
 */
export const FLAG_AGGREGATE: TopicRegistration = {
  aggregateType: 'flags',
  retention: 'full-history',
};

/** One per applied change, in the transaction of the change; it carries no definition (FR-052). */
export const FlagChanged = defineEvent(
  'experimentation.flag_changed',
  'flags',
  1,
  flagChangedPayloadSchema,
  { carries: 'delta' },
);

export { flagChangedEventSchema };
