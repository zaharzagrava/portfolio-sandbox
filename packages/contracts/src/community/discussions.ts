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

// ---- requests, enums and error codes (S25 T005, FR-073) ---------------------------------------------------------

/** Control characters (U+0000-U+001F, U+007F) and bidirectional overrides (U+202A-U+202E, U+2066-U+2069). */
export const hasForbiddenTitleChar = (text: string): boolean => {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (
      c <= 0x1f ||
      c === 0x7f ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    )
      return true;
  }
  return false;
};

const codePoints = (s: string) => [...s].length;

/** `POST /boards/:productId/posts` (the header `Idempotency-Key` is required). Unknown fields are refused. */
export const createPostRequestSchema = z.strictObject({
  title: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => codePoints(s) >= 3 && codePoints(s) <= 300)
    .refine((s) => !hasForbiddenTitleChar(s)),
  body: z
    .string()
    .refine((s) => codePoints(s) <= 40_000)
    .optional(),
});
export type CreatePostRequest = z.infer<typeof createPostRequestSchema>;

/** `POST /posts/:postId/comments`. */
export const createCommentRequestSchema = z.strictObject({
  body: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => codePoints(s) >= 1 && codePoints(s) <= 10_000),
  parentId: z.uuid().optional(),
});
export type CreateCommentRequest = z.infer<typeof createCommentRequestSchema>;

/** `PUT /votes/:targetId`: the server resolves the target type; a client-sent `targetType` is refused. */
export const voteRequestSchema = z.strictObject({ value: voteValue });
export type VoteRequest = z.infer<typeof voteRequestSchema>;

export const boardSortSchema = z.enum(['hot', 'top', 'new']);
export type BoardSort = z.infer<typeof boardSortSchema>;
export const topWindowSchema = z.enum(['day', 'week', 'month', 'year', 'all']);
export type TopWindow = z.infer<typeof topWindowSchema>;
export const threadSortSchema = z.enum(['best', 'new', 'old']);
export type ThreadSort = z.infer<typeof threadSortSchema>;

/** Stable `code` values of problem+json answers of the discussions API (spec Assumptions). */
export const DISCUSSION_ERROR_CODES = [
  'validation_failed',
  'invalid_cursor',
  'unauthorized',
  'forbidden',
  'board_not_found',
  'post_not_found',
  'comment_not_found',
  'parent_not_found',
  'target_not_found',
  'user_not_found',
  'board_closed',
  'parent_deleted',
  'target_deleted',
  'vote_in_progress',
  'request_in_progress',
  'idempotency_key_required',
  'idempotency_key_reuse',
  'max_depth_exceeded',
  'self_vote_not_allowed',
  'markdown_too_complex',
  'rate_limited',
  'service_unavailable',
] as const;
export type DiscussionErrorCode = (typeof DISCUSSION_ERROR_CODES)[number];
