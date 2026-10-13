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
