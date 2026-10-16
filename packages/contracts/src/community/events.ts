import { z } from 'zod';

/**
 * Payloads of the events S25 records with its writes and relays to `discussion.events` (key = `postId`), exactly as in
 * `specs/domains/S25-discussions/contracts/events.md`. The envelope and `defineEvent` live in the backend
 * (`libs/domains/community/domain/discussion-events.ts`). No event for votes, shadow-ban changes or shadow content.
 */
const deletedBy = z.enum(['author', 'moderator']);

export const discussionPostCreatedPayloadSchema = z.object({
  postId: z.string(),
  boardId: z.string(),
  authorId: z.string(),
  title: z.string(),
  createdAt: z.string(),
});

export const discussionPostDeletedPayloadSchema = z.object({
  postId: z.string(),
  boardId: z.string(),
  deletedBy,
});

export const discussionCommentCreatedPayloadSchema = z.object({
  commentId: z.string(),
  postId: z.string(),
  boardId: z.string(),
  authorId: z.string(),
  parentCommentId: z.string().nullable(),
  parentAuthorId: z.string().nullable(),
  postAuthorId: z.string(),
  /** First 140 code points of the plain text. */
  preview: z.string(),
  createdAt: z.string(),
});

export const discussionCommentDeletedPayloadSchema = z.object({
  commentId: z.string(),
  postId: z.string(),
  boardId: z.string(),
  deletedBy,
});

export const discussionVoteAnomalyPayloadSchema = z.object({
  targetId: z.string(),
  targetType: z.enum(['post', 'comment']),
  boardId: z.string(),
  zeroWeightVotes: z.number().int().nonnegative(),
  windowSeconds: z.number().int().positive(),
});

/**
 * `feed.item_published` v1 (topic `feed.events`, key = `authorId`; S26 contracts/events.md): announced at least once
 * after an item is stored, consumed by the S26 fan-out. The backend `defineEvent` lives in
 * `libs/domains/community/domain/feed-events.ts`.
 */
export const feedItemPublishedPayloadSchema = z.object({
  itemId: z.string(),
  authorId: z.string(),
  kind: z.enum([
    'new_product',
    'price_drop',
    'post',
    'drop_announced',
    'auction_started',
  ]),
  createdAt: z.string(),
});
export type FeedItemPublishedPayload = z.infer<
  typeof feedItemPublishedPayloadSchema
>;
