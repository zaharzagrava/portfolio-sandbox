import {
  LAUNCH_EVENTS_AGGREGATE,
  liveCommentPostedPayloadSchema,
  liveCommentRemovedPayloadSchema,
  liveReactionsAggregatedPayloadSchema,
  liveStreamEndedPayloadSchema,
  liveStreamStartedPayloadSchema,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * High-volume `live.*` events: aggregate `live`, topic `live.events`, key `streamId`, sent by the plain producer (there is
 * no relational transaction to be atomic with). Consumers: the history writer and async moderation.
 */
export const LiveCommentPosted = defineEvent(
  'live.comment_posted',
  'live',
  1,
  liveCommentPostedPayloadSchema,
);

/** v2: a structured reason (`moderator` | `auto`), the actor and the score. v1 (free text) is gone. */
export const LiveCommentRemoved = defineEvent(
  'live.comment_removed',
  'live',
  2,
  liveCommentRemovedPayloadSchema,
);

export const LiveReactionsAggregated = defineEvent(
  'live.reactions_aggregated',
  'live',
  1,
  liveReactionsAggregatedPayloadSchema,
);

/**
 * Lifecycle events go through the outbox in the status transaction (IX.6), on the domain's topic
 * `launch_events.events` (S22 settled the underscore: aggregate types cannot contain `-`).
 */
export const LiveStreamStarted = defineEvent(
  'live.stream_started',
  LAUNCH_EVENTS_AGGREGATE,
  1,
  liveStreamStartedPayloadSchema,
);
export const LiveStreamEnded = defineEvent(
  'live.stream_ended',
  LAUNCH_EVENTS_AGGREGATE,
  1,
  liveStreamEndedPayloadSchema,
);

export const LIVE_TOPIC: TopicRegistration = {
  aggregateType: 'live',
  retention: 'full-history',
};
