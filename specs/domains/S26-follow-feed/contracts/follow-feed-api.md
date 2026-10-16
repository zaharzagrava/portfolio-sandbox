# Contract: S26 HTTP API and in-process exports

All routes are under `/api`, `Firewall()` on every one (`401` problem+json without a valid session), errors are RFC 9457 problem+json with a stable `code`, no internals in `detail`. Schemas live in `packages/contracts/src/community/feed.ts` (new, exported from the contracts index) and every e2e response is parsed with them (VII.6).

## Routes

| Route | Request | Success | Errors | Rate profile |
|---|---|---|---|---|
| `POST /follow/:accountId` | `accountId` = `shop:<uuid>` \| `user:<uuid>`, lowercase UUID | `204`, no body; idempotent | `400 validation_failed`, `404 account_not_found` (unknown/deleted user; unknown shop or `DELETING`/`DELETED`; `SUSPENDED` shops can be followed), `422 cannot_follow_self`, `422 following_limit_reached {limit}`, `429`, `503 rate_limiter_unavailable` | `follow.write` (30/min/user, fail closed) |
| `DELETE /follow/:accountId` | same | `204`; also for a missing relation or a vanished account | `400 validation_failed`, `429`, `503 rate_limiter_unavailable` | `follow.write` |
| `GET /me/following` | `limit` 1–100 (default 50), `cursor` | `200 FollowingPage = {items: {accountId, followedAt}[], nextCursor: string \| null}`, newest follow first | `400 validation_failed` (bad limit, unknown query parameter), `400 invalid_cursor` | none (reads of one's own list; covered by the global default) |
| `GET /follow-status?accountIds=a,b,…` | ≤ 100 well-formed ids, comma-separated | `200 FollowStatus = {accountId, following, followerCount}[]` in request order; unknown accounts `{following:false, followerCount:0}` | `400 validation_failed` (> 100, malformed); duplicate ids are collapsed (one entry per distinct id, at its first position; AS-12) | `feed.read` |
| `GET /feed` | `limit` 1–50 (default 30), `cursor` | `200 FeedPage = {items: FeedItemView[], nextCursor: string \| null, degraded?: true}` | `400 validation_failed`, `400 invalid_cursor`, `429`, `503 feed_unavailable` | `feed.read` (120/min/user, fail open) |

Every rate-limited answer carries the structured `RateLimit` and `RateLimit-Policy` headers (S50). `429` adds `Retry-After`. `422 rate_limit_cost_exceeded` is the shared S50 code; no S26 route declares a cost above 1, so clients handle it generically.

`FeedItemView = {itemId, kind, author: {accountId, type: "shop" | "user", name: string | null}, title, payload, createdAt}`, `kind` ∈ `new_product | price_drop | post | drop_announced | auction_started`, `payload` per kind (integer minor units, no floats):

| kind | payload |
|---|---|
| `new_product` | `{productId, priceMinor, currency}` |
| `price_drop` | `{productId, previousPriceMinor, priceMinor, currency}` |
| `post` | `{postId, boardId}` |
| `drop_announced` | `{auctionId, productId, startsAt}` (ISO timestamp) |
| `auction_started` | `{auctionId, productId, endsAt}` |

(Field lists are AS-43 of `spec.md`.) `author.name` is the shop's name for shops and `null` for buyers.

Cursors are opaque, HMAC-signed (`feed` and `following` scopes; the feed cursor encodes `(createdAtMs, sortableItemId)`, the following cursor `(followedAtMs, accountId)`); a cursor from the other scope, an edited one, or a malformed one answers `400 invalid_cursor`. Unknown query parameters are rejected (`forbidNonWhitelisted`).

## Breaking changes against today's shapes (all accepted in `questions.md`)

`GET /feed?before=<ms>` → `?cursor=`; `{items, nextBefore}` → `{items, nextCursor, degraded?}`; item `authorId` + `kind: string` + `payload: Record` → `author{}` + typed payload; `GET /me/following` `string[]` → `FollowingPage`; self-follow `400` → `422 cannot_follow_self`; plain `BadRequestException` bodies → problem+json codes. Callers to adapt: `packages/contracts` consumers, the BFF upstream schema if it names these routes (none found by grep at plan time), journey J05.

## In-process exports (barrel `@app/domains/community`)

- `FeedModule`, `FeedWorkerModule`, `FeedProjectorsModule` (modules only; no consumer, projector or publisher class).
- `FollowQueryService.getFollowerIds(accountId: string, opts: {limit: number /* ≤ 1000 */; cursor?: string}): Promise<{ids: string[]; nextCursor: string | null}>` — active followers only (S28 follow-up; fail-closed stub on S28's side is replaced by this). `limit > 1000` throws a validation error; `cursor` is opaque.
- `communityRatePolicies` now also holds `follow.write` and `feed.read`.
