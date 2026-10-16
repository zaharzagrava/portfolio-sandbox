# Contracts: S31 interfaces

The route table, request and response shapes, status codes and error codes are those of `spec.md` ("Provides" and the acceptance scenarios); they are not repeated. This file fixes what the plan adds: where each schema lives, the error-code catalog, the events, the jobs and the policy declarations.

## Schemas (`packages/contracts/src/asset-library/`, exported from the package index)

`assetPrepareRequestSchema`, `assetPrepareResponseSchema`, `assetCommitRequestSchema`, `assetCommitResponseSchema` (outcome enum `created|updated|conflicted_copy|unchanged`), `assetSchema`, `assetPageSchema {items, nextCursor, syncCursor}`, `assetVersionPageSchema`, `assetChangePageSchema {items, nextCursor, hasMore}`, `assetManifestSchema {chunks[{index,hash,sizeBytes,url}], totalChunks, nextFrom}`, `shareLinkCreateRequestSchema`, `shareLinkSchema`, `shareLinkPreviewSchema`, `downloadGrantSchema`, `digitalProductLinkSchema`, `purchasePageSchema`, `assetEventSchemas`. Request schemas are `.strict()` (unknown property → `400`). Each has a parse test in the e2e assertions (VII.6).

## Problem catalog (`domain/errors.ts`, registered with `ProblemCatalogModule.forFeature(ASSET_PROBLEMS)`)

`validation_failed 400`, `permission_denied 403`, `shop_not_found 404`, `asset_not_found 404`, `version_not_found 404`, `share_link_not_found 404`, `entitlement_not_found 404`, `digital_link_not_found 404`, `product_not_found 404`, `cannot_delete_current_version 409`, `invalid_transition 409`, `path_taken 409`, `asset_in_use 409`, `asset_deleted 409`, `digital_product_sold 409`, `version_limit_reached 409`, `quota_exceeded 409`, `idempotency_in_flight 409`, `chunks_unknown 422`, `chunk_not_uploaded 422`, `chunk_size_mismatch 422`, `size_mismatch 422`, `invalid_base_version 422`, `invalid_cursor 422`, `idempotency_key_required 422`, `idempotency_key_invalid 422`, `idempotency_key_reuse 422`, `cursor_expired 410`, `link_unavailable 410`, `download_unavailable 410`, `rate_limited 429`, `storage_unavailable 503`. 5xx `detail` is generic.

## Events (`assetEventSchemas`, topic `assets.events`, `defineEvent` in `application/events/asset-events.ts`)

| Type | Aggregate (key) | Payload |
|---|---|---|
| `assets.entitlement_granted` | `entitlements` (`entitlementId`) | `{entitlementId, orderId, productId, shopId, buyerId, title, grantedAt}` |
| `assets.entitlement_revoked` | `entitlements` | `{entitlementId, orderId, productId, shopId, buyerId, reason, revokedAt}` |
| `assets.digital_product_linked` | `digital-products` (`productId`) | `{productId, shopId, assetId, linkedAt}` |
| `assets.digital_product_unlinked` | `digital-products` | `{productId, shopId, assetId, unlinkedAt}` |

Consumed: `order.paid`, `order.refunded` (`orders.events`, `orderEventSchemas`), `catalog.product_deleted` (`ProductDeleted`), `tenancy.shop_deleted` (`ShopDeleted`).

Realtime: topic `shop:<shopId>:assets`, event `assets.changed {lastSeq}` (policy already in `api/realtime-topics.ts`).

## Jobs (declared with `declareJobType`, `@JobHandler`, schedules upserted by the worker module)

`assets.gc-chunks` hourly, `assets.purge-deleted-assets` daily, `assets.purge-download-grants` daily, `assets.purge-changes` daily; each handler is idempotent and claims its work with `FOR UPDATE SKIP LOCKED` (AS-75).

## Rate-limit policies (`rate-limit-policies.ts`)

`assets.upload.shop` sliding window 120 / 60 s key `shop` closed; `assets.redeem.ip` 60 / 60 s key `ip` open; `assets.grant.user` 30 / 60 s key `user` closed.

## Config

`usercontent_origin` (must differ from the app origin in production), `assets_quota_bytes` (100 GiB), `assets_version_cap` (500), `assets_undelete_days` (30), `assets_journal_days` (90), `assets_gc_grace_hours` (24).
