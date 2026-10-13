# Contract: HTTP API of `media` photos (prefix `/api`)

Schemas live in `packages/contracts/src/media/` (`media.ts`, `gallery.ts`) and are the single source of truth for DTO validation (zod → `ValidationPipe`-compatible pipe: unknown fields rejected, `400 validation_failed` naming the fields) and for the e2e response parsing. All errors are problem+json (`type`, `title`, `status`, `detail`, `instance`, `requestId`) with a stable `code`.

## Routes

| Method and path | Auth | Request | Success | Errors (code) |
|---|---|---|---|---|
| `POST /media/uploads` | signed-in | `mediaUploadRequestSchema` `{purpose:"review"}` (strict) | `201 mediaUploadResponseSchema` | 400 `validation_failed`, 401, 409 `pending_uploads_limit` (+`count`), 429, 503 (limiter down) |
| `POST /shops/:shopId/media/uploads` | member, `products.write` | `{purpose:"product"}` (strict) | `201 mediaUploadResponseSchema` | 400, 401, 403 `permission_denied` \| `shop_suspended`, 404 (non-member and unknown shop identical), 409 `shop_offboarding` \| `pending_uploads_limit`, 429, 503 |
| `POST /media/:id/complete` | uploader (shop photo: still `products.write`) | — | `202 {status:"UPLOADED"\|"PROCESSING"}` or `200 {status:"READY"}` / `200 {status:"REJECTED", rejectCode}` | 400 (non-UUID), 401, 404 `media_not_found` (unknown, not yours, `DELETED`), 409 `upload_incomplete` \| `upload_expired` |
| `GET /media/:id` | optional | — | `200 mediaPublicSchema` (READY, `Cache-Control: public, max-age=15`) or `200 mediaOwnerSchema` (uploader / member with `products.read`, `Cache-Control: private, no-store`) | 400, 404 `media_not_found` (identical for non-ready/not-yours/deleted/unknown), 429 |
| `DELETE /media/:id` | uploader (shop photo: `products.write`) | — | `204` | 400, 401, 403 (`VIEWER` on a shop photo they can see), 404, 409 `media_in_use` (+`productIds`, caller's shop only) \| `media_busy` |
| `GET /batch/media?ids=a,b,…` | anonymous | ≤ 100 UUIDs | `200 mediaBatchItemSchema[]` parallel to the request, `null` for anything not READY | 400, 429 |
| `PUT /shops/:shopId/products/:productId/gallery` | member, `products.write` | `galleryPutRequestSchema` `{mediaIds: uuid[≤20, unique], expectedVersion: int ≥ 0}` (strict) | `200 galleryMemberSchema` | 400, 401, 403, 404 `product_not_found` (and the shop 404), 409 `product_archived` \| `version_conflict` (+`currentVersion`) \| `shop_offboarding`, 422 `media_not_attachable` (+`failures:[{mediaId, code: "not_found"\|"not_ready"}]`), 429 |
| `GET /shops/:shopId/products/:productId/gallery` | member, `products.read` | — | `200 galleryMemberSchema` `{items:[{mediaId, position, urls, width, height}], version}` | 400, 401, 404, 429 |
| `GET /products/:productId/gallery` | anonymous | — | `200 galleryPublicSchema` `{items}` ordered by position | 400, 404 (hidden = unknown), 429 |

**Breaking changes against today's code** (all in `questions.md`): `gallery PUT` answered `204` and now answers `200` with the body and needs `expectedVersion`; `complete` no longer answers `400` for a missing object or `200 {status}` for every state; `GET /media/:id` is no longer anonymous for non-READY photos and `rejectReason` is replaced by `rejectCode`; `purpose: "post"` is refused; `upload` no longer returns `key`.

## Schemas (shape; exact zod in `packages/contracts`)

```
mediaUploadRequestSchema   = { purpose: "review" | "product" }.strict()   // route decides which purpose is valid
mediaUploadResponseSchema  = { mediaId, upload:{ url, fields: Record<string,string>, expiresAt }, maxBytes: 15728640,
                               allowedContentTypes: ["image/jpeg","image/png","image/webp","image/avif"] }
mediaPublicSchema          = { id, status:"READY", purpose, shopId: string|null, width, height, urls:{thumb,feed,full} }
mediaOwnerSchema           = mediaPublicSchema fields (urls: null unless READY, width/height nullable)
                             + { status: <any non-DELETED>, rejectCode?: string, createdAt, updatedAt }
mediaBatchItemSchema       = mediaPublicSchema | null
galleryPutRequestSchema    = { mediaIds: uuid[] (max 20, unique), expectedVersion: int ≥ 0 }.strict()
galleryMemberSchema        = { items: [{ mediaId, position, urls, width, height }], version }
galleryPublicSchema        = { items: [{ mediaId, position, urls, width, height }] }
mediaProblemCodes          = the FR-073 vocabulary (const tuple, used by the filter mapping and the tests)
```

`upload.fields` contains the signed policy fields **including** the key (the browser needs it as the form field); the response has no separate `key` property and no other object's key. Every URL is `<media_cdn_url>/media/derived/<sha256>.webp`.

## Headers

- Public READY views and batch: `Cache-Control: public, max-age=15`. Owner views: `private, no-store`. Writes: `no-store`.
- `429` carries `Retry-After`; `X-RateLimit-*` per S50.
- No response of this capability contains an original's key (AS-55).

## Rate-limit policies

`media.upload.user` (POST /media/uploads), `media.upload.shop` (POST /shops/:shopId/media/uploads), `media.gallery.shop` (PUT gallery), `media.read.ip` (the four GET routes). See `research.md` R-10 for why `complete` and `DELETE` carry none.

## Exported lookup (R1, in-process)

```ts
MediaQueryService.getReadyMediaByIds(
  ids: MediaId[],                                          // ≤ 500, else RangeError
  options?: { uploaderId?: UserId; shopId?: ShopId; purpose?: 'product' | 'review' },
): Promise<Map<MediaId, MediaDto>>
// MediaDto = { id, shopId: ShopId | null, purpose, width, height, urls:{thumb,feed,full}, createdAt }
```

One statement; predicates inside the `WHERE`; only READY; duplicates collapse. Exported from `@app/domains/media` with `MediaModule`, `MediaWorkerModule`, `MediaProjectorModule`, `createMediaProcessor` (+ its dependency types), `VideoModule`, `VideoWorkerModule`, DTO types and `mediaEventSchemas` re-export. Nothing else (no model, repository, `MediaProcessor`, `Sql`, `MEDIA_QUEUE`).

## Worker core

```ts
createMediaProcessor(deps: MediaProcessorDeps): { process(originalKey: string): Promise<'READY'|'REJECTED'|'SKIPPED'|'BUSY'> }
// deps: repository (MediaRepository over a SqlRunner), tx, blobs, scanner, clock, metrics, logger, limits (optional overrides for tests)
// Transient failure ⇒ throws TransientProcessingError (message not acknowledged). The core never retries.
```
