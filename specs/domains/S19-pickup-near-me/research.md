# Research: S19 — Pickup near me

No `NEEDS CLARIFICATION` remains; each decision below resolves a choice the spec leaves to the plan.

## R-1 Index document and queries

- **Decision**: one document per (point, product) with stock > 0 and visible, `_id = "<pointId>:<productId>"`, written with `version_type: external_gte` and `version = max-of-sources` is **not** used. Instead the projector rebuilds the whole document from the four sources and writes it with a `docVersion = stockVersion + pointVersion + productVersion + shopVersion` (each monotonic, so the sum is monotonic and a replay in any order converges to the highest sum; equal sums imply identical inputs). Deletes are versioned the same way (`index.gc_deletes: 1h`).
- **Search**: `bool` filter `geo_distance` (radius, cell-independent, AS-03) + `range quantity > 0`; `match` on `title` (`fuzziness: AUTO`, `operator: and`) when `q`; `collapse` on `productId` with `inner_hits` size 1 sorted by `_geo_distance`; sort `_score`, `_geo_distance`, `productId`; pagination by `search_after` over that tuple. The cursor is `base64url(JSON{tuple, h})` where `h` = hash of the normalised query (q, lat, lng, radius); a mismatch → `400 validation_failed`.
- **Clusters**: `geo_bounding_box` (a box with `left > right` is split into two boxes in a `should`), `geotile_grid` at `precision = zoom` with `size: 500` ordered by `_count desc` then key, `geo_centroid`, `cardinality(pickupPointId, precision_threshold: 1000)`; `truncated` when `sum_other_doc_count > 0`.
- **Alternatives**: geohash grid (rejected: cell edges differ per zoom, notes' implementation record uses tiles); PostGIS for search (rejected, FR-024: exact store sized for writes).

## R-2 Exact browse

- **Decision**: one SQL statement: `ST_DWithin(location, point, :radiusM)` (index-assisted, `≤` radius so the boundary is included), `ORDER BY ST_Distance(location, point), id`, keyset predicate on `(distance, id)` taken from the cursor, `LIMIT :limit + 1`; optional `EXISTS` on `PickupStock` with `quantity > 0` joined to the **own** copy tables for visibility (`PickupProductCopy.status/isSandbox`, `PickupShopCopy.status`), executed in a read-only transaction with `SET LOCAL statement_timeout = 2000`; a query-canceled error (`57014`) maps to `503 service_unavailable`. `distanceM` is `round(ST_Distance)::int` (spheroid, within 1 m).
- **Why own copies in SQL**: visibility without touching `Product`/`Shop` (IX.4); the copies are fulfilment tables.

## R-3 Product events and tombstones (S05 follow-up)

- **Decision**: the product handler accepts `catalog.product_created|updated|archived|restored` (full snapshot, version = `productVersion`) and `catalog.product_deleted`. A copy row is upserted only if `productVersion` is greater than the stored one (`INSERT … ON CONFLICT DO UPDATE … WHERE excluded.version > copy.version`); `deleted` removes the copy **and** the product's stock rows (FR-033), one `pickup.stock_changed {quantity: 0}` each, in one transaction. A compacted-topic tombstone (null value / state "deleted") is treated as `deleted`. `catalog.product_changed` is not consumed. The copy keeps only fields the pickup index shows plus `shopId`.
- **Seeding**: the first stock write for a product upserts the copy from `getProductsByIds` with the same version guard, so the offer appears even if the product event was already compacted away or is late.
- **Verification at implementation**: read the real payload in `product-events.ts` / `@marketplace-sandbox/contracts` `productSnapshotSchema`; do not trust the spec's field list.

## R-4 Shop events

- **Decision**: `tenancy.shop_status_changed {shopId, to, shopVersion}` upserts `PickupShopCopy(status = to)` under the version guard. `tenancy.shop_deleted {shopId, shopVersion}` (S03 carries `shopVersion`; the spec text shows only `{shopId}`) marks the copy `DELETED`, then deactivates every active point of the shop (version +1, one `pickup.point_changed` each) in one transaction; repeating changes nothing (no active points left). A shop with no copy row is not visible (fail closed).
- **Gap in the spec**: a shop that was never suspended emits no status event, so its copy must start from `tenancy.shop_created` (a v1 event in `tenancy/domain/events.ts`). The shop handler therefore also consumes `shop_created` (initial status and `shopVersion` read from its real payload at implementation time). Recorded in `gaps.md` under "Spec changes" as a clarification of FR-032; AS-30's replay covers it.

## R-5 Per-shop limit of 100 points under concurrency

- **Decision**: in the create transaction take `pg_advisory_xact_lock(hashtextextended('pickup-points:' || :shopId, 0))`, then `SELECT count(*) FROM "PickupPoint" WHERE "shopId" = :shopId`, then insert. The lock is transaction-scoped (released at commit), store-enforced, own domain; two parallel creates serialise and exactly one gets the 100th slot. Inactive points count.
- **Alternatives**: unique `(shopId, slot)` table (more schema), `SERIALIZABLE` (retry logic), count-then-insert without a lock (races, rejected by III.6).

## R-6 Stock set and adjust in one statement

- **Set**: `INSERT … ON CONFLICT ("pickupPointId","productId") DO UPDATE SET quantity = :q, version = version + 1, "updatedAt" = :now WHERE "PickupStock".quantity <> :q AND ("PickupStock".version = :expected OR :expected IS NULL) RETURNING …`; zero rows are disambiguated by one `SELECT` in the same transaction (unchanged → 200 same version, version mismatch → `409 stock_version_conflict {currentVersion}`). `expectedVersion: 0` is an `INSERT … ON CONFLICT DO NOTHING` that returns zero rows when a row exists. Row-level locking of `ON CONFLICT DO UPDATE` gives unique increasing versions.
- **Adjust**: `UPDATE "PickupStock" SET quantity = quantity + :d, version = version + 1 WHERE … AND quantity + :d BETWEEN 0 AND 1000000 RETURNING`; no row → one `SELECT` decides `insufficient_pickup_stock {available}` / `stock_limit_exceeded` / `404`. A missing row with `delta > 0` is created from 0. The column keeps `CHECK (quantity >= 0)`; an upper `CHECK (quantity <= 1000000)` is added in the expand migration.
- **Event**: `stockVersion` = the row `version`, so the sequence of applied changes is gap-free and increasing per aggregate (AS-21 versions 2…6).

## R-7 Idempotency of adjustments

- **Decision**: S54 `@Idempotent({ ttlSeconds: 86400 })` on the adjustment route (header required → `422` when missing; replay header `Idempotency-Replayed: true`; different body `422`; in flight `409`). The facility stores in its own table; no new pickup table. AS-22: the outbox append and the stock update are in one `TransactionRunner.run`; a failure rolls back and the facility records no completed result, so a retry with the same key succeeds once. Verify against `idempotency.interceptor.ts` that a 5xx is not stored as the key's final answer; if it is, mark the failure retryable per the facility's API (no workaround in pickup code).

## R-8 Ordering and replay of the projector

- **Decision**: four consumer groups (`pickup-index-stock`, `-point`, `-product`, `-shop`), each `idempotency = 'versionGuard'`, `coalesce` only where every event is full state (stock, point, product; shop status too). Each handler loads the other sources from **own** tables (stock row, point row, copy rows) and calls `buildOfferDocument(...)`, so order between topics does not matter: the document is a function of the current state of the four sources, and `docVersion` (R-1) orders writes. Burst coalescing (AS-27): the framework reduces a batch to the highest `aggregateVersion` per aggregate, then one bulk action per (point, product). Product change fan-out reads the product's stock rows from `PickupStock` (≤ number of points × 1 product) and writes in chunks of 500. A point change over 10 000 stock rows is chunked the same way (Edge Cases).
- **Index bootstrap**: `indexExists` + `createIndex` at module init, idempotent (concurrent starters tolerate `resource_already_exists_exception`); unreachable engine fails the projector's readiness instead of a warning (A19).

## R-9 Metrics and logs

- Series: `pickup_search_duration_seconds{endpoint,outcome}`, `pickup_http_rejections_total{endpoint,code}` (429/503), `pickup_index_lag_seconds`, `pickup_consumer_lag`, `pickup_dead_letters_total{consumer}`, `pickup_stock_changes_total{kind=set|adjust|rejected}`, `pickup_index_write_failures_total`. Labels are fixed enums; no ids, coordinates or addresses. Logs use the platform logger with `requestId`; coordinates of shoppers and bodies are never logged (a log-capturing assertion in AS-45).

## R-10 Cache and CDN

- `Cache-Control: public, s-maxage=30` is set by the controller only on a successful clusters body; the global filter sets `no-store` on 429/503 problem responses (AS-39). `search/near` and `pickup-points/near` are `no-store` (location-specific).

## R-11 Sibling follow-ups not built here

- S10/S20 (`OrderFulfilmentService`), S24/S25/S11/S21/S30/S38 (BFF upstream schemas) are other capabilities' work; recorded in `gaps.md`. Only `pickupPageSchema` is S19's and is replaced by a re-export.

## R-12 Real payloads read at implementation time (T003)

- **Product events** (`catalog/application/events/product-events.ts`, aggregate `products`, topic `products.events`, key `productId`, `aggregateVersion = productVersion`): `catalog.product_created|updated|archived|restored` v1 carry `productSnapshotSchema` (strict): `productId, shopId, title, description, brand, category, priceMinor (int), currency, rating, tags, quantity, inStock, status ('ACTIVE'|'ARCHIVED'), isSandbox, externalSku, productVersion, createdAt, updatedAt, changedFields`. `catalog.product_deleted` v1: `{productId, shopId, productVersion}` (strict). The copy keeps `productId, shopId, title, category, priceMinor, currency, status, isSandbox, productVersion`.
- **Tombstone**: the S53 framework (`envelope-parser.ts`) dead-letters a null-value message (`INVALID_ENVELOPE`) before any handler runs, so a handler never sees a bare tombstone. The `catalog.product_deleted` event is the deletion signal; the copy handler has no tombstone branch.
- **R1 DTO** (`ProductDto`, `getProductsByIds(ids, {shopId})`): `id, shopId, title, category, priceMinor, currency, status, isSandbox, version` among others. The seed uses these.
- **Shop events** (`tenancy/domain/events.ts`, aggregate `tenancy`, topic `tenancy.events`, key `shopId`): `tenancy.shop_created` v1 `{shopId, ownerId, name, slug, plan, region, shopVersion}` (no status: a created shop is `ACTIVE`); `tenancy.shop_status_changed` v1 `{shopId, from, to ('ACTIVE'|'SUSPENDED'|'DELETING'|'DELETED'), reason?, shopVersion}`; `tenancy.shop_deleted` v1 `{shopId, shopVersion}`.
- **Framework**: the runner validates the envelope, the `handles` payload schemas and the contract version; unknown types are skipped; invalid payloads, newer versions and bad aggregate ids are dead-lettered. Handlers get validated envelopes. The AS-26 invalid-message cases therefore run through the real runner (`ConsumerKit` pattern of `product-invalidation.e2e-spec.ts`), the duplicate cases through `project()`.
