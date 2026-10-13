# Contract: HTTP API of video (`/api`, problem+json with `code`)

Schemas live in `packages/contracts/src/media/video.ts` and are parsed by every e2e test (VII.6). Problem bodies are RFC 9457 with `code` from the table at the end; 5xx details are generic. IDs in paths are UUIDs (`400` otherwise). Seller routes sit behind `Firewall` + `@ShopScoped(permission)`; non-member and unknown shop answer the same `404`.

## Seller routes

| Route | Permission | Request schema | Success | Rate limit |
|---|---|---|---|---|
| `POST /shops/:shopId/videos` | `products.write` | `videoStartRequestSchema` `{title, sizeBytes, contentType, visibility, productId?}` strict | `201` `videoStartResponseSchema` `{videoId, partSize, partCount, expiresAt, visibility, shareToken: string\|null, parts:[{partNumber,url,contentLength}]}` | `video.start.shop` |
| `GET /shops/:shopId/videos/:id/upload` | `products.write` | — | `200` `videoUploadStateSchema` `{status:'UPLOADING', partSize, partCount, uploadedParts:[{partNumber,size}], missingParts:number[], parts, expiresAt}` | `video.write.shop` |
| `POST /shops/:shopId/videos/:id/complete` | `products.write` | `videoCompleteRequestSchema` `{parts:[{partNumber, etag}]}` (non-empty, strictly ascending) | `202` `videoCompleteResponseSchema` `{status:'PROCESSING'}`; replay on `PROCESSING` `202`; `READY` `200 {status}`; `FAILED` `200 {status, failureCode}` | `video.write.shop` |
| `GET /shops/:shopId/videos` | `products.read` | query `limit` (1–50, default 20), `cursor`, `status` | `200` `videoListSchema` `{items: videoOwner[], nextCursor: string\|null}` | global |
| `GET /shops/:shopId/videos/:id` | `products.read` | — | `200` `videoOwnerSchema` `{id, title, visibility, status, failureCode, retryable, productId, durationSec, width, height, renditions, progress:{stage,tasksDone,tasksTotal}, posterUrl, spriteUrl, shareToken, version, createdAt, updatedAt}` | global |
| `PATCH /shops/:shopId/videos/:id` | `products.write` | `videoPatchRequestSchema` `{title?, productId?: string\|null, expectedVersion}` strict | `200` `videoOwnerSchema` | `video.write.shop` |
| `POST /shops/:shopId/videos/:id/retry` | `products.write` | — | `202` `{status:'PROCESSING'}` | `video.write.shop` |
| `DELETE /shops/:shopId/videos/:id` | `products.write` | — | `204` | `video.write.shop` |

## Public routes (anonymous)

| Route | Success | Headers | Rate limit |
|---|---|---|---|
| `GET /videos/:id/playback?token=` | `200` `videoPlaybackSchema` `{videoId, title, masterUrl, posterUrl, spriteUrl: string\|null, durationSec, width, height, renditions:[{name,width,height}], expiresAt: string\|null}` | public: `Cache-Control: public, max-age=60`, no cookie; unlisted: `private, no-store` + three signed cookies (`Secure; HttpOnly; SameSite=None; Path=/u/<id>/; Domain=<cookie domain>; Expires=+4h`) | `video.playback.ip` (fail open) |
| `GET /products/:productId/videos` | `200` `productVideosSchema` `{items:[{videoId,title,posterUrl,durationSec}]}` (≤ 10, `READY` public, newest first) | `public, max-age=15` | `video.playback.ip` |

`productVideosSchema` is the BFF's upstream schema (S48): same exported name, now defined in `media/video.ts`. `videoPlaybackSchema` keeps `spriteUrl` tolerant of absence for old parsers; the server always sends `null` or a URL.

## Breaking changes versus today (W02/W04 are the only possible clients; neither ships video code)

1. Start response: no `uploadId`, `key`, `partUrls`; adds `partCount`, `expiresAt`, `visibility`, `shareToken`, `parts[].contentLength`. Start request: adds `contentType`, `visibility`, optional `productId`; unknown fields rejected.
2. Playback: unlisted needs `?token=`; adds `title`, `spriteUrl`, `width`, `height`, `renditions`, `expiresAt`; every hidden state is the same `404`; cookie `Domain` is the configured parent domain; cookie lifetime is `Expires`.
3. Complete: `202 PROCESSING` (was `200`), request carries etags validated against storage.

## Problem codes (`video-errors.ts`; HTTP status)

`validation_failed` 400 · `invalid_cursor` 400 · `permission_denied` 403 · `shop_suspended` 403 · `video_not_found` 404 · `product_not_found` 404 · `shop_offboarding` 409 · `product_archived` 409 · `pending_uploads_limit` 409 `{limit,current}` · `upload_incomplete` 409 `{missingParts}` · `upload_closed` 409 `{status}` · `upload_expired` 409 · `version_conflict` 409 `{currentVersion}` · `product_video_limit` 409 · `not_retryable` 409 · `retry_limit` 409 · `source_purged` 409 · `invalid_state` 409 `{status}` · `parts_mismatch` 422 · `rate_limited` 429 (+ `Retry-After`) · `storage_unavailable` 503 · `service_unavailable` 503 (limiter store down on fail-closed routes; unlisted signing missing) · `401` unauthenticated per the platform filter.
