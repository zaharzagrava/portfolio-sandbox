# Contract: S42 internal services, ports and consumed services

## Barrel `@app/domains/developer-platform` (after the change)

Exports: `DevelopersModule`, `PublicApiModule`, `PublicApiWorkerModule`, `PublicApiProjectorModule` (new), `ApiVersionService`, `developerPlatformRatePolicies`, DTO types and event contracts, and — until S43/S44 move — the existing `Webhooks*Module`, `WidgetModule`, `WebhookDeliverer`, `WebhookRouterProjector`. `ApiRequestsProjector` leaves the barrel (apps import `PublicApiProjectorModule`; `apps/projector` is updated). Webhook and widget exports are S43/S44's and stay as they are.

## Exported service (R1)

`ApiVersionService`: `supportedVersions(): readonly ApiVersion[]`, `latestVersion(): ApiVersion`, `isSupported(version: string): boolean`, `getPinnedVersions(shopIds: ShopId[]): Promise<Map<ShopId, ApiVersion>>` (≤ 500; latest for an unpinned shop; one statement).

## Consumed (R1, in-process, never inside a transaction)

| Service | Call | Used for |
|---|---|---|
| S03 `ShopProvisioningService` | `ensureSandboxShop(liveShopId)` → `ShopSummaryDto` | first call of a test key |
| S03 `ShopQueryService` | `getShopsByIds(ids ≤ 500)` | shop status, `expand=shop` for a page |
| S03 `ShopScoped(permission)` | dashboard routes | `shop.manage`, `shop.read`, status gate |
| S05 `ProductCommandService` | `create`, `update(…, expectedVersion)`, `getForShop`, `listByShop` | products |
| S05 `ProductQueryService` | `getProductsByIds(ids, {shopId})` | bulk pre-lookup, batch tenant check |
| S05 `ProductStockService` | `applyStockDelta(ops ≤ 100)` | stock deltas |
| S10 `OrderQueryService` | `getOrdersForShop`, `getOrderLines`, **new** `getShopOrder(shopId, shopOrderId)` | orders |
| S18 | `checkQuota('SHOP', shopId, 'apiCallsPerMonth')` behind `QuotaPort` (not yet exported: allowed + counter) | quota |
| S50 | `definePolicies`, `@RateLimit(policy, {cost})`, `RateLimitModule.forFeature` | limits |
| S52 | `CacheService.getOrLoad`, `invalidate` | key and shop-status entries |
| S53 | outbox append, consumer runtime, queue port | events, consumers, bulk queue |
| S54 | `TransactionRunner.run`, `CLOCK`, config validation, metrics, filter, shutdown | everywhere |
| S01/S02 | `Firewall({sensitive:true})`, `@User()` with `amr` | key routes |
| Shared idempotency | `@Idempotent({required, scope})`, `IdempotencyRepository` | creating POSTs, batch operations |

Not used: `SecretBox` (keys are hashed), any `*Model` of another domain, any raw SQL on `Shop`, `Product`, `ShopOrder`, `BisOrder`, `BisOrderItem`.

## Domain ports (`domain/ports.ts`; adapters in `infra/`)

`ApiKeyRepository` (create-with-limit, conditional rotate, conditional revoke, list, find by prefix, revoke-all-for-shop, monotonic lastUsed), `KeyCache` (get-with-tombstone, fill-if-absent, tombstone, invalidate), `ShopSettingsRepository` (pin if absent, conditional change, get many), `BulkJobRepository` (create with chunks, complete chunk, read, purge), `UsageBucketRepository` (add, close), `RequestLogStore` (insert with token, search), `RequestRecordSink` (publish with timeout), `QuotaPort`, `ShopDirectory` (R1 adapter over S03), `CatalogGateway` (R1 adapter over S05), `OrderGateway` (R1 adapter over S10), `Clock`.

Pure modules in `domain/`: `api-key-format`, `key-status`, `version-registry` + `versioning`, `deprecation`, `sparse-fields`, `bulk-chunking`, `usage-bucket`, `batch-plan`.

## Application services (one per controller)

`ApiKeysService`, `ApiVersionService`, `RequestLogService`, `UsageReportService` (dashboard); `PublicCatalogService`, `PublicOrdersService`, `BatchService`, `BulkStockService` (public); `ShopLifecycleHandler`, `UsageMeteringHandler`, `BulkChunkWorker`, `KeyUsageFlusher`, `UsageCloser`, `BulkPurger` (async). Typed `ApiError` subclasses map to the code catalogue in `http.md` through the S54 filter; no controller builds an error body.
