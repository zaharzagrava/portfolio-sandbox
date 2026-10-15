# Ports and cross-domain calls: S08

## Domain ports (`domain/ports`, DI tokens; adapters in `infra/`)
- `IntegrationRepository`: `insertConnected`, `transition(id, from, to, reason, actor)` (conditional UPDATE + history), `findInShop(shopId, id)` (shop and ID in one predicate), `listPage`, `countActiveForShop`, `dueForSync(now, limit)`, breaker counters.
- `LinkRepository`: `getForUpdate`, `upsertApplied`, `markState`, `findByLocal(shopId, productId)`, `pageForReconcile`.
- `CursorRepository`: `claimLease(id, holder, ttl) → fence | null`, `renewLease`, `checkpoint(fence, page)`, `advanceWatermark(fence, value)`.
- `RunRepository`, `QuarantineRepository`, `ConflictRepository`, `ReceiptRepository`, `ReconciliationRepository`, `InstallRepository`.
- `CommerceProvider` (one per provider, token `COMMERCE_PROVIDERS`): `buildAuthorizeUrl`, `exchangeCode`, `verifyCallback`, `verifyCredentials → {currency, locationId}`, `listChanged(since, pageCursor) → Page<RawItem>` (envelope validated), `listAllIdsAndDigests`, `fetchOne(externalId)`, `setStock(externalId, value, expected) → accepted | precondition_failed | gone`, `registerWebhooks`, `deregisterWebhooks`, `parseWebhook(headers, rawBody) → {topic, deliveryId, triggeredAt?, externalId?}`, `verifyWebhook`, `refreshToken?`. No fake in production wiring.
- `Clock`, `SyncQueue` (`enqueue(queue, msg, {delaySeconds?})`, validates at creation), `CredentialVault` (`seal/open` with `integration:<id>`), `CatalogGateway`, `ShopStatusGateway`, `ProviderCallPolicy` (limiter + breaker + retry).

## R1 calls into other domains (only these)
| Domain | Call | Notes |
|---|---|---|
| catalog | `ProductImportService.upsertFromExternal(shopId, items ≤500, 'shopify'\|'woocommerce')` | items carry `priceMinor`; `quantity` only when no link; `rejected` → quarantine `catalog_rejected`; `ShopNotActiveError` → `skipped_shop_not_active` |
| catalog | `ProductStockService.applyStockDelta(ops)` | deterministic `operationId`, reasons `sync-inbound`/`sync-deleted`; `insufficient_stock` → oversold conflict; `not_found` → link `IGNORED`; `unavailable` → retry/drift; `StockOperationConflictError` handled |
| catalog | `ProductQueryService.getProductsByIds(ids ≤500, {shopId})` | reconciliation only |
| tenancy | `ShopQueryService.getShopsByIds(ids ≤500)` | once per scheduled pass, once per run start |
| identity | `SecretBox.seal/open(…, context)`, `Firewall`, `@User()` | |
| infrastructure | outbox, task queue, rate limiter, jobs, consumer framework, `safeRequest`, metrics, clock | |

Never: `Product`, `Shop`, membership or outbox tables; `products.events` writes; `sequelize.transaction`.
