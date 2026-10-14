import {
  chatMessageEscalatedPayloadSchema,
  chatMessagePostedPayloadSchema,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';

/** The aggregate all chat events belong to; registered once by the worker and the projector (`EventsModule.forAggregates`). */
export const CHAT_AGGREGATE = {
  aggregateType: 'chat',
  retention: 'full-history',
} as const;

/**
 * Written by the insert trigger of `ChatMessage` (migration 20261014140000) for messages from Rust AND NestJS, with a
 * deterministic `eventId` derived from the message id (a relay that repeats a row repeats the id). Aggregate id is the
 * channel, aggregate version the message's sequence number. Dated exception to IX.6 until 2027-03-31 (research R-03).
 */
export const ChatMessagePosted = defineEvent(
  'chat.message_posted',
  'chat',
  1,
  chatMessagePostedPayloadSchema,
);

/**
 * A message the recipient has not read and is not online to see: appended once per (recipient, channel) per
 * coalescing window, for whoever tells people about it (chat does not know who that is: S28). The preview is the
 * message's own preview, never the author's name or e-mail. `dedupeKey` is chat's idempotency key for the escalation:
 * a retry of the same escalation carries the same key.
 */
export const ChatMessageEscalated = defineEvent(
  'chat.message_escalated',
  'chat',
  1,
  chatMessageEscalatedPayloadSchema,
);
