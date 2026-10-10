# Event contract: S05 — Products

Topic `products.events` (aggregate type `products`, `latest-per-key`, key = `productId`). Registered through `PRODUCTS_AGGREGATE` (`retention: 'latest-per-key'`); every definition of the aggregate carries `state`, which the registry's policy check enforces.

## Envelope (S53)

`{eventId (uuidv7), type, version: 1, aggregateType: 'products', aggregateId: productId, aggregateVersion: productVersion, occurredAt, traceparent?, payload}`. `aggregateVersion` equals the payload's `productVersion` and rises by exactly 1 for each event of one product (create = 1; delete = last + 1). A committed change that changes nothing writes no event.

## Types

| Type | Written by | Payload |
|---|---|---|
| `catalog.product_created` | `create`, `upsertFromExternal` (new) | snapshot, `changedFields: []` |
| `catalog.product_updated` | `update`, `applyStockDelta` (`["quantity"]`), `upsertFromExternal` (changed), backfill (`["shopId"]`) | snapshot, `changedFields` = names that changed |
| `catalog.product_archived` | `archive` | snapshot (`status: "ARCHIVED"`) |
| `catalog.product_restored` | `restore` | snapshot (`status: "ACTIVE"`) |
| `catalog.product_deleted` | shop purge | `{productId, shopId, productVersion}` |

Snapshot payload (zod `productEventSchemas`, strict): `{productId, shopId, title, description, brand, category, priceMinor, currency, rating, tags, quantity, inStock, status, isSandbox, externalSku: string|null, productVersion, createdAt, updatedAt, changedFields: string[]}`. Never in events: view counts, `createdBy`, embeddings. Size ≤ 256 KiB (envelope limit); in practice < 12 KiB by the field limits.

`changedFields` vocabulary: `title, description, brand, category, priceMinor, currency, quantity, tags, shopId`.

## Consumed

| Consumer (group) | Event | Mechanism | Effect |
|---|---|---|---|
| `product-cache-invalidator` | `catalog.product_created|updated|archived|restored` (and legacy `catalog.product_changed`) | version guard (`invalidateIfOlder`), own coalescing per `productVersion` | delete entry, raise minimum; legacy event = unconditional `invalidate` |
| same | `catalog.product_deleted` | natural | unconditional `invalidate` (positive and negative) |
| `product-shop-status` | `tenancy.shop_status_changed` v1 | `versionGuard` on `shopVersion` | upsert `ProductShopState`; enqueue `products.drop-shop-entries` |
| `product-shop-deleted` | `tenancy.shop_deleted` v1 | natural + idempotent job key | mark `DELETED`; enqueue `products.purge-shop` |

All three declare `handles` with the event definitions (zod validation by the framework), `aggregateIdSchema: z.string().uuid()` for the product topic, and have their own consumer group; invalid envelopes go to the DLQ without effect and without blocking the batch (AS-44, AS-78).

## Consumers of this topic elsewhere (follow-ups in `gaps.md`)

S32 (index projector, popularity from `getProductsByIds(...).viewCount`), S19, S25/S26, S43, S40, S24, S34, S35, S36 switch from reading `Product` to the snapshot. Replay of the compacted topic rebuilds their copies.
