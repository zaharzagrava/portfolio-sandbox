# Contract: S25 HTTP API

Authoritative text: [`spec.md`](../spec.md) "Cross-capability contracts". Zod schemas live in `packages/contracts/src/community/discussions.ts` (extended by this change; exported from the package index). All paths are under `/api`. Errors are `application/problem+json` (`type, title, status, detail, instance, requestId, code`). Every response carries `X-Content-Type-Options: nosniff`.

| Method + path | Auth | Rate policy | Request | Success | Errors (`code`) |
|---|---|---|---|---|---|
| `POST /boards/:productId/posts` | user | `discussion.write` | header `Idempotency-Key`; body `CreatePostRequest {title, body?}` | `201 PostView` | 400 `validation_failed`; 401 `unauthorized`; 404 `board_not_found`; 409 `board_closed`, `request_in_progress`; 422 `idempotency_key_required`, `idempotency_key_reuse`; 429 `rate_limited`; 503 `service_unavailable` / `rate_limiter_unavailable` |
| `GET /boards/:productId/posts?sort&window&limit&cursor` | anonymous ok | platform read default | – | `200 PostPage {items, nextCursor, degraded?}` | 400 `validation_failed`, `invalid_cursor` |
| `GET /posts/:postId` | anonymous ok | read default | – | `200 PostView` | 400; 404 `post_not_found` |
| `DELETE /posts/:postId` | user | – | – | `204` | 401; 403 `forbidden`; 404 `post_not_found` |
| `POST /posts/:postId/comments` | user | `discussion.write` | `Idempotency-Key`; `CreateCommentRequest {body, parentId?}` | `201 CommentView` | 400; 401; 404 `post_not_found`, `parent_not_found`; 409 `board_closed`, `parent_deleted`, `request_in_progress`; 422 `max_depth_exceeded`, idempotency codes; 429; 503 |
| `GET /posts/:postId/comments?sort=best/new/old&limit&cursor` | anonymous ok | read default | – | `200 CommentThreadPage {items: CommentNode[], nextCursor, degraded?}` | 400 `validation_failed`, `invalid_cursor`; 404 `post_not_found` |
| `GET /comments/:commentId/replies?limit&cursor` | anonymous ok | read default | – | `200 CommentRepliesPage {items: CommentView[], nextCursor}` | 400 `invalid_cursor`; 404 `comment_not_found` |
| `DELETE /comments/:commentId` | user | – | – | `204` | 401; 403 `forbidden`; 404 `comment_not_found` |
| `PUT /votes/:targetId` | user | `discussion.vote` | `VoteRequest {value: -1, 0 or 1}` | `200 VoteResult` | 400; 401; 404 `target_not_found`; 409 `target_deleted`, `vote_in_progress` (+`Retry-After`); 422 `self_vote_not_allowed`; 429; 503 `service_unavailable` (cache down) |
| `PUT /moderation/shadow-bans/:userId` | `ADMIN` / `MODERATOR` | – | – | `204` | 401; 403 `forbidden`; 404 `user_not_found` |
| `DELETE /moderation/shadow-bans/:userId` | `ADMIN` / `MODERATOR` | – | – | `204` | same |

## Changes against the shipped code (all `[BREAKING]` in `questions.md`)

- Board ID = product UUID (route param `:productId`, `ParseUUIDPipe`); `product-<uuid>` and `brand:*` are `400`.
- Lists answer `{items, nextCursor}` (was `{posts, next}`); the flat `thread`/`bestThread` shapes are gone; `path` is never exposed.
- Vote body is `{value}` only; the response always has all six fields.
- `PostView` gains `score`, `myVote`, `commentCount` (was `comments`); `CommentView` gains `myVote`, `replyCount`, `deletedBy`; tombstones carry `authorId: null`.
- `GET /comments/:id/replies` and `DELETE /posts/:id` are new (W02-storefront-discovery B-4, B-5).

## Rate-limit surface (S50 follow-up)

`@RateLimit('discussion.write' | 'discussion.vote')` from `communityRatePolicies` (already declared with `definePolicies`; numbers unchanged). A `429` carries `RateLimit`, `RateLimit-Policy` and `Retry-After`; `discussion.write` (fail closed) answers `503 rate_limiter_unavailable` when the limiter store is down; `422 rate_limit_cost_exceeded` is unreachable (cost 1 everywhere). The e2e files assert the headers and codes. Anonymous GET routes lose `skipThrottle` and take the platform default.

## Query parameters

`sort` (`hot|top|new` for boards, default `hot`; `best|new|old` for threads, default `best`), `window` (`day|week|month|year|all`, only with `sort=top`, default `all`), `limit` (integer 1–50, default 25), `cursor` (opaque, bound to board+sort+window / post / comment). Anything else is `400`; nothing falls back.
