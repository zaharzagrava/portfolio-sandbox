import {
  commentRepliesPageSchema,
  commentThreadPageSchema,
  postPageSchema,
  postViewSchema,
  commentViewSchema,
  voteResultSchema,
  type BoardSort,
  type CommentRepliesPage,
  type CommentThreadPage,
  type CommentView,
  type PostPage,
  type PostView,
  type ThreadSort,
  type TopWindow,
  type VoteResult,
} from '@marketplace-sandbox/contracts';
import { endSession } from '@/lib/auth/session-ended';
import { apiClient } from './client';
import { problemFromError } from './errors';
import { parseBody } from './parse';
import { believesSignedIn } from './session-presence';

export type { BoardSort, CommentRepliesPage, CommentThreadPage, CommentView, PostPage, PostView, ThreadSort, TopWindow, VoteResult };

/** Page sizes of W02 Defaults: 20 posts, 25 top-level comments, 5 replies. */
export const POSTS_PAGE_SIZE = 20;
export const THREAD_PAGE_SIZE = 25;
export const REPLIES_PAGE_SIZE = 5;

type Read = { signal?: AbortSignal };

/** A write made while the browser is offline fails at once, shaped like an axios error without an answer (status 0). */
class OfflineError extends Error {
  constructor() {
    super('offline');
    this.name = 'OfflineError';
  }
}

/**
 * Every write goes through here: offline fails before any request (AS-74), and a `401` answer while a member is signed in
 * runs W01's session-ended flow, once (AS-51), whatever its `code` (the shared client only knows the session codes).
 */
async function write<T>(send: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new OfflineError();
  try {
    return await send();
  } catch (error) {
    if (problemFromError(error).status === 401 && believesSignedIn()) endSession();
    throw error;
  }
}

const segment = encodeURIComponent;

/** `GET /api/boards/{productId}/posts`: `window` is sent only with `sort=top` (FR-081). */
export async function listPosts(
  productId: string,
  request: { sort: BoardSort; window?: TopWindow; cursor?: string },
  { signal }: Read = {},
): Promise<PostPage> {
  const params: Record<string, string | number> = { sort: request.sort, limit: POSTS_PAGE_SIZE };
  if (request.sort === 'top' && request.window) params.window = request.window;
  if (request.cursor) params.cursor = request.cursor;
  const { data } = await apiClient.get<unknown>(`/api/boards/${segment(productId)}/posts`, { params, signal });
  return parseBody(postPageSchema, data);
}

/** `POST /api/boards/{productId}/posts` with the attempt's `Idempotency-Key`. */
export function createPost(productId: string, post: { title: string; body?: string }, key: string): Promise<PostView> {
  return write(async () => {
    const { data } = await apiClient.post<unknown>(`/api/boards/${segment(productId)}/posts`, post, {
      headers: { 'Idempotency-Key': key },
    });
    return parseBody(postViewSchema, data);
  });
}

/** `GET /api/posts/{postId}/comments`: up to 25 top-level comments with at most 5 replies each. */
export async function listComments(
  postId: string,
  request: { sort: ThreadSort; cursor?: string },
  { signal }: Read = {},
): Promise<CommentThreadPage> {
  const params: Record<string, string | number> = { sort: request.sort, limit: THREAD_PAGE_SIZE };
  if (request.cursor) params.cursor = request.cursor;
  const { data } = await apiClient.get<unknown>(`/api/posts/${segment(postId)}/comments`, { params, signal });
  return parseBody(commentThreadPageSchema, data);
}

/** `GET /api/comments/{commentId}/replies`, oldest first. */
export async function listReplies(
  commentId: string,
  request: { limit?: number; cursor?: string } = {},
  { signal }: Read = {},
): Promise<CommentRepliesPage> {
  const params: Record<string, string | number> = { limit: request.limit ?? REPLIES_PAGE_SIZE };
  if (request.cursor) params.cursor = request.cursor;
  const { data } = await apiClient.get<unknown>(`/api/comments/${segment(commentId)}/replies`, { params, signal });
  return parseBody(commentRepliesPageSchema, data);
}

/** `POST /api/posts/{postId}/comments`; `parentId` only for a reply. */
export function createComment(postId: string, comment: { body: string; parentId?: string }, key: string): Promise<CommentView> {
  return write(async () => {
    const { data } = await apiClient.post<unknown>(
      `/api/posts/${segment(postId)}/comments`,
      comment.parentId ? { body: comment.body, parentId: comment.parentId } : { body: comment.body },
      { headers: { 'Idempotency-Key': key } },
    );
    return parseBody(commentViewSchema, data);
  });
}

/** `PUT /api/votes/{targetId} {value}`: 1, -1, or 0 to retract. The server resolves the target type. */
export function putVote(targetId: string, value: 1 | -1 | 0): Promise<VoteResult> {
  return write(async () => {
    const { data } = await apiClient.put<unknown>(`/api/votes/${segment(targetId)}`, { value });
    return parseBody(voteResultSchema, data);
  });
}

export function deletePost(postId: string): Promise<void> {
  return write(async () => {
    await apiClient.delete(`/api/posts/${segment(postId)}`);
  });
}

export function deleteComment(commentId: string): Promise<void> {
  return write(async () => {
    await apiClient.delete(`/api/comments/${segment(commentId)}`);
  });
}
