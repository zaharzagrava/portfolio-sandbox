# Contract — backend endpoints W02 calls and the additions it makes

All browser calls are relative same-origin `/api/...` (rewritten to the BFF forwarder, W01 C-FWD). Server reads use `API_URL` / `BFF_URL` from server-only modules. "Exists" was verified in code on 2026-10-11.

## Calls W02 makes (existing)

| Surface | Call | Caller | Schema (`packages/contracts`) | Status |
|---|---|---|---|---|
| Search | `GET /api/products/search` | `search.server.ts` (first view, `no-store`), `lib/api/search.ts` | `productSearchResponseSchema` | exists (S32) |
| Click log | `POST /api/search/clicks {searchId, productId, position}` (`keepalive`) | `lib/api/search.ts` | `searchClickRequestSchema` | exists |
| Suggest | `GET /api/suggest?q&limit=8` | `lib/api/suggest.ts` | `suggestResponseSchema` | exists (S33) |
| Trending | `GET /api/trending?limit=8` (category `all`) | `trending.server.ts` | `trendingResponseSchema` | exists (S35) |
| Category shortcuts | `GET /api/products/search?facets=true&limit=1` | `category-shortcuts.server.ts` | `productSearchResponseSchema` | exists |
| Product aggregate | `GET {BFF_URL}/api/bff/product-page/{id}` (anonymous) | `product-page.server.ts` | `productPageResponseSchema` (+ `gallery`, B-2) | exists; `gallery` added |
| Pickup search | `GET /api/search/near` | `lib/api/pickup.ts` | `pickupNearSearchResponseSchema` | exists (S19); schema added |
| Pickup list / clusters | `GET /api/pickup-points/near`, `GET /api/pickup-points/clusters` | `lib/api/pickup.ts` | `pickupPointsNearResponseSchema`, `pickupClustersResponseSchema` | exists; schemas added |
| Discussions | `GET /api/boards/{productId}/posts`, `POST /api/boards/{productId}/posts`, `GET /api/posts/{postId}/comments`, `GET /api/comments/{id}/replies`, `POST /api/posts/{postId}/comments`, `PUT /api/votes/{targetId}`, `DELETE /api/comments/{id}` | `lib/api/discussions.ts` | `postPageSchema`, `postViewSchema`, `commentThreadPageSchema`, `commentRepliesPageSchema`, `commentViewSchema`, `voteResultSchema` | exist (S25) except `GET /comments/:id/replies` (**missing → B-5**); schemas added |
| Delete post | `DELETE /api/posts/{postId}` | `lib/api/discussions.ts` | — | **missing → B-4** |
| Ask | `POST /api/products/{id}/ask` (`text/event-stream`) | `lib/api/ask.ts` | `ragAskRequestSchema`, `ragStreamEventSchema` | exists (S47); schemas added |
| Share | `POST /api/links {destination}` + `Idempotency-Key` | `lib/api/share.ts` | `createShortLinkRequestSchema`, `shortLinkSchema` | exists (S37); schemas added |
| Events | `POST /api/events {events:[…]}` | `lib/analytics/track.ts` (through `lib/api/events.ts`) | `clientEventBatchSchema` | exists (S39); schema added |
| Video playback | `GET /api/videos/{id}/playback` | `lib/api/videos.ts` | `videoPlaybackSchema` | exists (S30); schema added |
| Sponsored slot | `GET /api/ads/sponsored?category&limit=3` | `lib/api/ads.ts` | `sponsoredSlotsResponseSchema` | **not built** (no controller); flag off, JA `fixme` |

## Additions made by this plan

### B-1 `GET /api/products/{productId}/gallery` (S29 AS-38)

- Anonymous. `200 {items: [{mediaId, position, urls: {thumb, feed, full}, width, height}]}` ordered by `position`; only `READY` media; `Cache-Control: public, max-age=15` is **not** set (the BFF caches; direct callers get `no-store` defaults of the API).
- `404 not_found` identical for unknown, archived, sandbox product, product of a suspended/deleting shop; `400 validation_failed` for a malformed id. Visibility comes from the S05/S03 clients (R1), never from their tables.
- Schema: `productGallerySchema` (`packages/contracts/src/media/gallery.ts`), also used by `productPageResponseSchema.gallery`.
- Spec: `packages/backend/libs/domains/media/media-gallery-public.e2e-spec.ts` (happy, order, non-READY excluded, 404 uniformity, 400, no auth needed, response parsed with the schema).

### B-2 `gallery` section in `GET /api/bff/product-page/{id}`

- One registry entry: name `gallery`, endpoint B-1, budget 300 ms, optional, anonymous-safe; response field `gallery: ProductGallery | null`; `BFF_SECTIONS` gains `gallery` (so `errors[].section` may be `gallery`).
- Failure of the section: `gallery: null` plus an `errors` entry; the rest is unchanged. Update `bff-contracts.spec.ts` and `bff.e2e-spec.ts`.

### B-4 `DELETE /api/posts/{postId}` (S25 FR-005, FR-052)

- Auth required. Author, or caller with role `ADMIN`/`MODERATOR`. `204` on first delete and on repeat (idempotent); `403 forbidden` for another user; `404 post_not_found`; `401` without credentials.
- Effect: post marked deleted (body erased as for comments), listing and counts exclude it, one `discussion.post_deleted` event per first delete. Spec: `discussions-delete-post.e2e-spec.ts`.

### B-5 `GET /api/comments/{commentId}/replies?limit&cursor` (S25 FR-012, AS-20)

- Anonymous allowed. `200 {items: CommentView[], nextCursor: string | null, degraded?: true}` in thread order (oldest first, parents before children), `limit` 1–50 default 5; opaque cursor; malformed/tampered/foreign cursor → `400 invalid_cursor`; unknown or hidden comment → `404 comment_not_found`; malformed id → `400 validation_failed`. `discussion.service.ts` already reads the first five replies per branch (`repliesPer = 5`); this adds the paged read of the rest.
- Spec: `discussions-replies.e2e-spec.ts` (12 replies in pages of 5 → 5 + 5 + 2 exactly once, cursor errors, 404, anonymous, shadow-ban visibility as S25).

### B-7 Schemas added to `packages/contracts/src`

`fulfilment/pickup.ts`, `community/discussions.ts`, `assistant/ask.ts`, `marketing/share.ts`, `marketing/ads.ts`, `media/gallery.ts`, `media/video.ts`, `events/client-events.ts`; exported from the package index with the names of the table above. Each schema is derived from the controller DTO or response type that already exists; a test per file parses a response produced by the real controller (or a fixture generated from it).

## Web-side endpoint

| Endpoint | Behaviour |
|---|---|
| `POST /api/attribution/ref` (Route Handler in `packages/web`) | Body `{code}`; same-origin only (`Origin`/`Sec-Fetch-Site`); `^[A-Za-z0-9_-]{1,64}$` else `204` with no cookie; valid → `204` + `Set-Cookie: __Host-ref=<code>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`; never reads or sets another cookie; wins over the `/api/:path*` rewrite because rewrites run after the file system. |

## Obligations on other capabilities (sibling follow-ups, also in `gaps.md`)

- **S34 / S35**: additive `imageUrl: string | null` on rail items.
- **S36**: `GET /api/ads/sponsored` controller (the web is ready behind `STOREFRONT_ADS_ENABLED`).
- **S10 / W03**: order creation reads `getRefCode()` (`lib/attribution/ref.server.ts`) and accepts the attribution code.
- **S05**: category is a lowercase slug (`^[a-z0-9-]{1,40}$`).
- **S19**: journey path is `packages/web/tests/storefront-discovery.spec.ts`.
- **S37**: `SITE_URL` equals the configured storefront origin.
