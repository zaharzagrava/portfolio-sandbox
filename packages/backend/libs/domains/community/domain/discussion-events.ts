import {
  discussionCommentCreatedPayloadSchema,
  discussionCommentDeletedPayloadSchema,
  discussionPostCreatedPayloadSchema,
  discussionPostDeletedPayloadSchema,
  discussionVoteAnomalyPayloadSchema,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * `discussion.events` (key = `postId`): post and comment lifecycle for the feed (S26) and notifications (S28).
 * Recorded in the same logged batch as the write (S25 R-3) and relayed at least once with a stable `eventId`.
 * No event for votes, shadow-ban changes or shadow content. Payloads: `specs/domains/S25-discussions/contracts/events.md`.
 */
export const DISCUSSION_AGGREGATE: TopicRegistration = {
  aggregateType: 'discussion',
  retention: 'full-history',
};

export const DiscussionPostCreated = defineEvent(
  'discussion.post_created',
  'discussion',
  1,
  discussionPostCreatedPayloadSchema,
);

export const DiscussionPostDeleted = defineEvent(
  'discussion.post_deleted',
  'discussion',
  1,
  discussionPostDeletedPayloadSchema,
);

export const DiscussionCommentCreated = defineEvent(
  'discussion.comment_created',
  'discussion',
  1,
  discussionCommentCreatedPayloadSchema,
);

export const DiscussionCommentDeleted = defineEvent(
  'discussion.comment_deleted',
  'discussion',
  1,
  discussionCommentDeletedPayloadSchema,
);

export const DiscussionVoteAnomalyDetected = defineEvent(
  'discussion.vote_anomaly_detected',
  'discussion',
  1,
  discussionVoteAnomalyPayloadSchema,
);

export const DISCUSSION_EVENTS = [
  DiscussionPostCreated,
  DiscussionPostDeleted,
  DiscussionCommentCreated,
  DiscussionCommentDeleted,
  DiscussionVoteAnomalyDetected,
] as const;
