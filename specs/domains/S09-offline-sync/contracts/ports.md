# Internal ports (domain/ports/, DI tokens; adapters in infra/)

No port is exported from the barrel. Names avoid S08's tokens (`CONFLICT_REPOSITORY`, `CATALOG_GATEWAY`, `SYNC_CLOCK` is reused as is).

| Token | Methods (shape) | Adapter |
|---|---|---|
| `SYNC_OPERATION_REPOSITORY` | `claim(op, now): {kind:'claimed'}\|{kind:'existing', row}`; `takeOver(shopId, opId, seenClaimedAt, now): boolean`; `complete(shopId, opId, outcome, conflict?, now)` (one transaction: conditional `pending → terminal`, `SyncConflict` insert, `outbox.append`); `listStale(before, limit)`; `purgeBefore(before, limit)`; `countPending()` | `SequelizeSyncOperationRepository` |
| `SYNC_FEED_REPOSITORY` | `append(shopId, entry): 'appended'\|'duplicate'\|'stale'` (state-row lock inside); `page(shopId, afterSeq, limit)`; `bootstrap(shopId, afterSeq, limit)`; `state(shopId)`; `compact(shopId, before, limit)`; `startGeneration(shopId)`; `deleteShop(shopId, limit)` | `SequelizeSyncFeedRepository` |
| `SYNC_FIELD_CLOCK_REPOSITORY` | `read(shopId, productId)`; `advance(shopId, productId, {field→hlc})` (conditional upsert); `deleteProduct`, `deleteShop` | `SequelizeFieldClockRepository` |
| `SYNC_PRODUCT_EDIT_LOCK` | `withLock(shopId, productId, deadline, fn)` (advisory lock on a dedicated connection, outside CLS) | `PgAdvisoryProductEditLock` |
| `SYNC_CONFLICT_REPOSITORY` | `page(shopId, {status, limit, cursor})`; `dismiss(shopId, opId, actorId, now): record\|null`; `find(shopId, opId)`; `countOpen()` | `SequelizeSyncConflictRepository` |
| `SYNC_CATALOG_GATEWAY` | `applyStock(op): {kind:'applied', quantityAfter, productVersion, replayed}\|{kind:'rejected', code}`; `quantityOf(shopId, productId)`; `product(shopId, productId)`; `updateFields(shopId, productId, expectedVersion, fields): {kind:'updated', version}\|{kind:'version_conflict'}\|{kind:'invalid', fields}\|{kind:'archived'}\|{kind:'not_found'}`; `listProducts(shopId, cursor)` | `SyncCatalogServicesGateway` over `ProductStockService`, `ProductQueryService`, `ProductCommandService` from `@app/domains/catalog` only |
| `SYNC_CLOCK` (existing) | `now()` | existing `CLOCK` |
| `SYNC_SHOP_STATUS` | reuse S08's `SHOP_STATUS_GATEWAY` if needed for offboarding checks; otherwise none (`ShopScoped` already gates) | existing |

Pure domain functions (no ports): `parseOp`, `fingerprint`, `classifyStock(delta, quantity, outcome)`, `clampDelta`, `decideFields(fields, hlc, clocks)`, `encodeCursor/decodeCursor`, `Hlc` ops (`plausible(hlc, now, driftMs)`), `expired(hlc, now, maxAgeMs)`.
