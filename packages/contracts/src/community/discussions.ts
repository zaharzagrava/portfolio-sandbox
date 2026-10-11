import { z } from 'zod';

/**
 * S25 discussion wire shapes (specs/domains/S25-discussions/spec.md, Cross-capability contracts). `bodyHtml` is
 * allow-list output; a client still sanitises it before insertion (S25 FR-043). Responses stay open to additive fields.
 */

const voteValue = z.union([z.literal(-1), z.literal(0), z.literal(1)]);
const count = z.number().int().nonnegative();
const degraded = z.literal(true).optional();

export const postViewSchema = z.object({
  postId: z.string(),
  boardId: z.string(),
  authorId: z.string(),
  title: z.string(),
  bodyHtml: z.string(),
  createdAt: z.string(),
  ups: count,
  downs: count,
  score: z.number().int(),
  commentCount: count,
  myVote: voteValue.nullable(),
});
export type PostView = z.infer<typeof postViewSchema>;

/** `authorId` is null and `bodyHtml` empty for a tombstone (`deleted: true`). */
export const commentViewSchema = z.object({
  commentId: z.string(),
  postId: z.string(),
  parentId: z.string().nullable(),
  depth: count,
  authorId: z.string().nullable(),
  bodyHtml: z.string(),
  createdAt: z.string(),
  ups: count,
  downs: count,
  score: z.number().int(),
  myVote: voteValue.nullable(),
  deleted: z.boolean(),
  deletedBy: z.enum(['author', 'moderator']).optional(),
  replyCount: count,
});
export type CommentView = z.infer<typeof commentViewSchema>;

export const commentNodeSchema = commentViewSchema.extend({
  replies: z.array(commentViewSchema),
  hasMoreReplies: z.boolean(),
});
export type CommentNode = z.infer<typeof commentNodeSchema>;

/** `GET /boards/:productId/posts` */
export const postPageSchema = z.object({
  items: z.array(postViewSchema),
  nextCursor: z.string().nullable(),
  degraded,
});
export type PostPage = z.infer<typeof postPageSchema>;

/** `GET /posts/:postId/comments` */
export const commentThreadPageSchema = z.object({
  items: z.array(commentNodeSchema),
  nextCursor: z.string().nullable(),
  degraded,
});
export type CommentThreadPage = z.infer<typeof commentThreadPageSchema>;

/** `GET /comments/:commentId/replies` */
export const commentRepliesPageSchema = z.object({
  items: z.array(commentViewSchema),
  nextCursor: z.string().nullable(),
  degraded,
});
export type CommentRepliesPage = z.infer<typeof commentRepliesPageSchema>;

/** `PUT /votes/:targetId` */
export const voteResultSchema = z.object({
  targetId: z.string(),
  targetType: z.enum(['post', 'comment']),
  ups: count,
  downs: count,
  score: z.number().int(),
  myVote: voteValue,
});
export type VoteResult = z.infer<typeof voteResultSchema>;
