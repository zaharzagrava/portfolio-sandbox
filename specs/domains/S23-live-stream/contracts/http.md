# HTTP contracts (S23)

All under `/api`; errors are problem+json with `code` and `requestId`; `5xx` details are generic. Schemas live in `packages/contracts/src/live/`. The authoritative list is `spec.md` "Provides".

| Route | Auth | Success | Schema | Errors |
|---|---|---|---|---|
| `POST /shops/:shopId/live` | `ShopScoped('products.write')` | 201 | `createLiveStreamRequestSchema` → `liveStreamSchema` | 401, 403, 404 (non-member), 422 |
| `POST /shops/:shopId/live/:streamId/start` | `products.write` | 200 (also repeat) | `liveStreamSchema` | 404 `stream_not_found`, 409 `stream_ended`, 503 |
| `POST /shops/:shopId/live/:streamId/end` | `products.write` | 200 (also repeat, also from SCHEDULED) | `liveStreamSchema` | 404, 503 |
| `PUT /shops/:shopId/live/:streamId/pin` | `products.write` | 200 (identical body: same `version`) | `pinRequestSchema` → `pinSchema` | 400 malformed ID, 404, 409 `stream_not_live`, 422 `product_not_pinnable` / bounds |
| `DELETE /shops/:shopId/live/:streamId/pin` | `products.write` | 204 | none | 404 (unpin with nothing pinned, also on an ended stream, is `204`) |
| `DELETE /shops/:shopId/live/:streamId/comments/:commentId` | `products.write` | 204 | none | 400, 404 `comment_not_found`, 503 |
| `POST /shops/:shopId/live/:streamId/mutes/:userId` | `products.write` | 204 | none | 400, 404, 422 `cannot_mute_staff` |
| `DELETE /shops/:shopId/live/:streamId/mutes/:userId` | `products.write` | 204 | none | 400, 404 |
| `POST /live/:streamId/comments` | session, `live.comment` | 201 new, 200 retry | `postCommentRequestSchema` → `liveCommentSchema` | 400, 401, 403 `user_muted`, 404, 409 `stream_not_live`, 422 (`comment_blocked` with `reason`, `client_id_reused`, validation), 429, 503 `live_unavailable` |
| `POST /live/:streamId/reactions` | session, `live.reaction` | 202 empty | `reactRequestSchema` | 401, 404, 409, 422, 429, 503 |
| `GET /live/:streamId` | anonymous, `live.snapshot.ip`, `Cache-Control: public, s-maxage=1` | 200 | `liveSnapshotSchema` (+ `degraded?: true`) | 400, 404 |
| `GET /live/:streamId/history?minute&limit&cursor` | anonymous | 200 | `liveHistoryPageSchema` | 404, 422 |
| `GET /live/:streamId/events` | anonymous (optional session), `live.events.ip` | `text/event-stream` | events in [events-and-realtime.md](events-and-realtime.md) | 400, 404, 409 `stream_ended`, 429, 503 `gateway_full` (`Retry-After: 5`) |

Check order on `POST /live/:streamId/comments` (FR-019): authentication → rate limit → body (zod, strict) → stream exists → `LIVE` → mute → synchronous moderation. On a shop-scoped route a non-member, or a stream that belongs to another shop, answers `404`; a member without the permission answers `403`; closed shops answer `403 shop_suspended` / `409 shop_offboarding` from the guard.

Moved routes (breaking, questions.md): `PUT/DELETE /live/:id/pin`, `DELETE /live/:id/comments/:commentId`, `POST /live/:id/mutes/:userId` no longer exist; there is no alias.
