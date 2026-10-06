# Feature Specification: S05 — Products: CRUD, Pricing, Stock Fields, Product Cache and Invalidation, Product Views (domain `catalog`)

**Feature Branch**: `S05-products` (spec directory `specs/domains/S05-products`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S05 of `scripts/sdd/capabilities.tsv`. Sources: `README.md` (showcases #21–#23), `docs/showcase/sections/SD-34-distributed-cache.md`, `03-Databases/04-redis-and-caching.md` §3, §4, §8, §9. Pattern-map row covered: **P0324** (cache-aside, write-behind, stale-while-revalidate, stampede, avalanche, penetration, hot and big keys).

## Scope

A **product** is something a shop sells: a title, a description, a price, a stock count and a lifecycle. This capability owns the product record, the rules for changing it, the fast public read of it, and the counters that say how often it was looked at.

In scope:

- Product create, read, update, list, archive and restore by the members of a shop, with optimistic concurrency and strict validation.
- Price (integer minor units, one platform currency) and stock fields, and the exported commands other domains use to read and change them: batch read by IDs, idempotent stock deltas that never go below zero, and idempotent upsert of externally sourced products.
- The public product page read: cache-aside with stale-while-revalidate, jittered lifetimes, negative caching, single-flight recompute, in-process hot-key promotion, bounded value size, ETag and CDN headers, and graceful degradation when the cache or the database is unhealthy.
- Cache invalidation: delete-on-write, event-driven invalidation that is safe against duplicate, out-of-order and racing events.
- Product views: write-behind counting and batched flushing.
- The versioned product events every other domain reacts to, and the catalog's own reactions to shop events (suspension, deletion) and to the shop-id backfill.
- The batch read endpoint the BFF composes (IX.7 R2 target).

Out of scope (owned elsewhere):

- Search, autocomplete, facets, the product index and its projector, shop-scoped product search → **S32** (search routes and the search projector leave this domain; debt D-15, D-16). Recommendations, trending → **S34**, **S35**.
- Collaborative listing drafts and their publish step → **S06** (publish changes a product only through this capability's update path).
- Bulk import, Shopify/WooCommerce sync, offline sync, and their conflict rules (`ProductFieldClock`, links, cursors) → **S07**, **S08**, **S09**. They call this capability's exported commands.
- Cart, checkout, reservations, order state, flash-sale stock buckets → **S10**, **S11**. Payment → **S13**. Auction stock → **S21**. They call `applyStockDelta`.
- Product photos, video and the gallery links (`ProductMedia`) → **S29**, **S30**. Digital delivery → **S31**.
- Tenant resolution, roles, shop status → **S03**. The cache toolkit itself (L1/L2, single-flight, XFetch, write-behind counter, ETag helper) → **S52**; this capability states how it is used. Outbox, consumers, projections → **S53**. Rate-limit engine → **S50**. Job scheduler → **S49**. Error filter, request context → **S54**.
- Product-count entitlements per plan → **S18**. Web screens → **W02** (product page) and **W04** (inventory). Cross-domain journeys → **J02**, **J04**.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A seller lists a product and keeps it current (Priority: P1)

A member of a shop adds a product, edits its price and stock, takes it off sale and puts it back. Two people editing at once never silently overwrite each other, and nobody can touch another shop's products.

**Why this priority**: no product, no marketplace. Every other capability reads what this one writes.

**Independent Test**: with two shops and users of each role, create, edit, list, archive and restore a product; replay stale versions and cross-shop identifiers; check responses and persisted rows after each step.

**Acceptance Scenarios**:

1. **AS-01** (create) — **Given** a `STAFF` member of an `ACTIVE`, non-sandbox shop `S`, **When** `POST /shops/S/products {title:"Wool coat", description:"Warm", brand:"Nord", category:"coats", priceMinor:12900, quantity:5, tags:[" Winter ","winter","Wool"]}`, **Then** `201` with the member view: `id` (UUID), `shopId: S`, `status: "ACTIVE"`, `version: 1`, `viewCount: 0`, `rating: 0`, `priceMinor: 12900`, `currency` the platform currency, `quantity: 5`, `inStock: true`, `tags: ["winter","wool"]` (trimmed, lower-cased, de-duplicated, order kept), `createdAt = updatedAt`; exactly one product row (`createdBy` the caller, `isSandbox: false`) and exactly one outbox row `catalog.product_created` (`productVersion: 1`, full snapshot) exist, committed together; the body carries no `sellerId`, search vector, embedding or other internal field and parses with `productMemberSchema`; no cache entry for the product exists yet.
2. **AS-02** (create validation) — **Given** the create form, **When** the body: omits `title`, `brand`, `category` or `priceMinor`; has a `title` that is empty, whitespace or longer than 200 characters; a `description` longer than 4,000; a `brand` or `category` empty or longer than 100; a `priceMinor` that is not an integer (`12.5`, `"100"`), is `0`, negative, or above `10000000000`; a `quantity` negative, fractional or above `1000000000`; more than 32 tags, an empty tag, a tag longer than 50 characters or a non-string tag; or contains any field outside the schema (`shopId`, `id`, `status`, `version`, `rating`, `viewCount`, `sellerId`, `createdBy`, `isSandbox`, `externalSku`); or the `shopId` in the path is not a UUID, **Then** `400 validation_failed` (problem+json) listing each offending field, and nothing is persisted: no product row, no outbox row.
3. **AS-03** (currency) — **Given** the platform currency `C`, **When** a body carries `currency: "C"`, **Then** it is accepted; **When** it carries any other currency code, **Then** `422 currency_not_supported` and nothing is persisted; omitting it means `C`.
4. **AS-04** (who may write) — **Given** a request without credentials, **Then** `401`; **Given** a `VIEWER` member, **Then** `403 permission_denied`; **Given** a user who is not a member of shop `S`, or a shop `S` that does not exist, **Then** the same `404` body for both (existence is hidden); in every case nothing is persisted. Reads of the same shop by a `VIEWER` succeed (AS-13).
5. **AS-05** (shop status gate) — **Given** shop `S` is `SUSPENDED`, **When** a member with `products.write` creates, updates, archives or restores a product, **Then** `403 shop_suspended`; **Given** `S` is `DELETING`, **Then** `409 shop_offboarding`; nothing changes. The same checks apply to the exported commands of AS-63 and AS-64 (a `ShopNotActiveError`).
6. **AS-06** (removed routes) — **Given** the removed routes `POST /products` (no shop) and `POST /products/shops/:shopId`, **When** called, **Then** `404` (no such route); no product is created.
7. **AS-07** (update) — **Given** product `P` at `version: 3`, **When** a member with `products.write` sends `PATCH /shops/S/products/P {expectedVersion:3, priceMinor:9900, quantity:12}` with the clock frozen at `T`, **Then** `200` with the member view: `priceMinor: 9900`, `quantity: 12`, `version: 4`, `updatedAt: T`, every other field unchanged; one outbox row `catalog.product_updated` (`productVersion: 4`, `changedFields: ["priceMinor","quantity"]`, full snapshot) was written in the same transaction; the product's cache entry is already gone when the response is returned (AS-39).
8. **AS-08** (update validation) — **Given** `PATCH`, **When** `expectedVersion` is missing, not a positive integer, or the body has no field to change besides it; a changed field breaks any rule of AS-02 (a field may be omitted, never `null`); the body contains an immutable or foreign field (`id`, `shopId`, `status`, `rating`, `viewCount`, `version`, `externalSku`, `isSandbox`, `createdBy`); or an ID in the path is not a UUID, **Then** `400 validation_failed` naming the fields, and the row, `version` and outbox are untouched.
9. **AS-09** (no-op update) — **Given** product `P` at `version: 3`, **When** a `PATCH` with `expectedVersion: 3` carries values equal to the stored ones (after the normalisation of AS-01), **Then** `200` with the unchanged view (`version: 3`, `updatedAt` unchanged), no row write, no outbox row and the cache entry untouched; **When** the same body carries `expectedVersion: 2`, **Then** `409 version_conflict` (the version is checked before the no-op).
10. **AS-10** (stale version) — **Given** `P` at `version: 4`, **When** a `PATCH`, `archive` or `restore` carries `expectedVersion: 3`, **Then** `409 version_conflict` whose body carries `currentVersion: 4`; nothing changes and no event is written.
11. **AS-11** (concurrent edits) — **Given** `P` at `version: 3`, **When** two members send `PATCH` with `expectedVersion: 3` at the same moment (different titles), **Then** exactly one answers `200` (`version: 4`) and the other `409 version_conflict`; the stored title is the winner's; exactly one `catalog.product_updated` row was written.
12. **AS-12** (cross-shop access) — **Given** shops `A` and `B` with a member in each and product `PA` of `A`, **When** the member of `B` calls `GET`, `PATCH`, `archive` or `restore` on `/shops/B/products/PA`, or on `/shops/A/products/PA`, **Then** `404` in both cases, with a body identical to the `404` for an unknown product ID (`product_not_found` for the first, the S03 hidden-shop `404` for the second); `PA` is unchanged and `B`'s list never contains `PA`.
13. **AS-13** (read one as a member) — **Given** a member of any role (including `VIEWER`) of `S`, **When** `GET /shops/S/products/P`, **Then** `200` with the member view for both `ACTIVE` and `ARCHIVED` products (including `quantity`, `status`, `version`, `externalSku` or `null`, `createdAt`, `updatedAt`); an unknown product answers `404 product_not_found`; a non-UUID ID answers `400`.
14. **AS-14** (list, paging) — **Given** 45 products of shop `S` (several with equal `createdAt`) and products of other shops, **When** `GET /shops/S/products?limit=20` and then the returned `nextCursor` twice, **Then** the pages hold 20, 20 and 5 items, ordered by `createdAt` descending then `id` descending, with no duplicate and no omission even if a new product is created between two page requests; the last page has `nextCursor: null`; no product of another shop appears; the default `limit` is 20; `limit=0`, `limit=101`, a non-numeric limit, an `offset` or `page` parameter, a tampered cursor, and a cursor issued for another shop or another filter set answer `400` (`validation_failed`, or `invalid_cursor` for the cursors).
15. **AS-15** (list filters) — **Given** products with mixed `status`, `category` and stock, **When** `GET /shops/S/products` with `status=ARCHIVED`, `category=coats`, `inStock=false`, or a combination, **Then** only matching products are returned (the default `status` is `ACTIVE`); `inStock=false` means `quantity = 0`; an unknown `status` value or an unknown parameter answers `400`; filters apply before paging, so `nextCursor` is correct for the filtered set.
16. **AS-16** (archive) — **Given** an `ACTIVE` product `P` at `version: 4`, **When** `POST /shops/S/products/P/archive {expectedVersion:4}`, **Then** `200` with `status: "ARCHIVED"`, `version: 5`; one status-history row (`from: ACTIVE`, `to: ARCHIVED`, the actor, the time) and one outbox row `catalog.product_archived` were written in the same transaction; `GET /products/P` now answers `404` for the writer immediately (AS-39) and `GET /batch/products?ids=P` returns `null` for it.
17. **AS-17** (restore) — **Given** an `ARCHIVED` product at `version: 5`, **When** `POST .../restore {expectedVersion:5}`, **Then** `200` with `status: "ACTIVE"`, `version: 6`, a history row (`ARCHIVED → ACTIVE`) and `catalog.product_restored`; `GET /products/P` is `200` again for the writer immediately (a cached "not found" for it is gone).
18. **AS-18** (illegal transitions) — **Given** an `ARCHIVED` product, **When** `archive` is called with the current version, **Then** `409 invalid_transition`; **Given** an `ACTIVE` product, **When** `restore` is called with the current version, **Then** `409 invalid_transition`; no history row, no event, no version change.
19. **AS-19** (edit while archived) — **Given** an `ARCHIVED` product, **When** `PATCH` with the current version, **Then** `409 product_archived` and nothing changes; after `restore` the same `PATCH` succeeds.
20. **AS-20** (archive races edit) — **Given** `P` `ACTIVE` at `version: 4`, **When** `archive {expectedVersion:4}` and `PATCH {expectedVersion:4, title}` run at the same moment, **Then** exactly one answers `200` and the other `409` (`version_conflict` or `product_archived`); the final row is consistent with the winner (archived and old title, or active with the new title) and exactly one event was written.
21. **AS-21** (status machine, pure) — **Given** the status machine, **When** every (status, transition) pair is evaluated (`ACTIVE→ARCHIVED` by `archive`, `ARCHIVED→ACTIVE` by `restore`), **Then** only those two succeed and every other pair is `invalid_transition`; the table is exhaustive (a new status makes the test fail to compile).
22. **AS-22** (write rate limit) — **Given** the write policy of 120 writes per minute per shop, **When** the 121st write (any of create, update, archive, restore) of shop `S` arrives within the minute, **Then** `429 rate_limited` with `Retry-After`, nothing is changed, and reads of the same shop still succeed; **Given** the limiter's store is unavailable, **Then** writes are refused with `503` (fail closed) and reads are unaffected.

---

### User Story 2 — A shopper opens a product page and it is fast and correct (Priority: P1)

A visitor opens a product page. The page data comes from a shared cache that is kept honest: it survives a rush on one product, a flood of made-up addresses, an expiring entry, and a sick cache or database.

**Why this priority**: the product page is read a thousand times for every write. It is where cache failure modes show up first.

**Independent Test**: read a product cold and warm, in parallel and across expiry; ask for hidden and made-up products; break the cache and the database; count the queries the database received.

**Acceptance Scenarios**:

1. **AS-23** (detail) — **Given** an `ACTIVE` product of an `ACTIVE`, non-sandbox shop, **When** anyone (no credentials) calls `GET /products/P`, **Then** `200` with the public view `{id, shopId, title, description, brand, category, priceMinor, currency, rating, tags, inStock, version, viewCount, updatedAt}` and nothing else (no `quantity`, `status`, `sellerId`, `createdBy`, search fields), parsed by `productPublicSchema`; headers `ETag: W/"<id>-v<version>"` and `Cache-Control: public, s-maxage=15, stale-while-revalidate=30`; exactly one cache entry for the product now exists; one view is counted (AS-66).
2. **AS-24** (conditional request) — **Given** the response above, **When** the same call carries `If-None-Match` equal to its `ETag`, **Then** `304` with an empty body and the same `ETag`, and the view is counted; **Given** a later update of `P`, **When** the old `ETag` is sent, **Then** `200` with the new body and a new `ETag`.
3. **AS-25** (hidden products) — **Given** an `ARCHIVED` product, a product of a sandbox shop, and a product of a `SUSPENDED`, `DELETING` or `DELETED` shop, **When** each is requested by anyone, **Then** `404 product_not_found` with a body identical to the one for an unknown ID, `Cache-Control: public, s-maxage=5`, and no view is counted.
4. **AS-26** (malformed ID) — **Given** `GET /products/not-a-uuid` or an over-long ID, **Then** `400 validation_failed`, with zero database statements and no cache entry written or read.
5. **AS-27** (cache-aside) — **Given** a cold product, **When** it is read twice, **Then** the first read loads the row with one statement and stores it, the second is served from the cache with zero statements, and both bodies are equal (metric outcome `miss`, then a cache hit); **Given** a product is changed by the write path (AS-39), **Then** the next read is a miss again: writes delete the entry, they never write it.
6. **AS-28** (avalanche) — **Given** 200 products read for the first time in the same second, **Then** every entry has a lifetime (none without), all lifetimes lie within ±10% of the base lifetime (60 s fresh plus 300 s stale window), and they are spread over at least 10 distinct values: entries written together do not expire together.
7. **AS-29** (stampede) — **Given** a cold, existing product, **When** 100 reads arrive concurrently on one instance, **Then** all answer `200` with the same body and the database received exactly one statement for the product; **When** the same happens spread over two instances sharing the cache, **Then** at most two statements.
8. **AS-30** (stale-while-revalidate) — **Given** an entry past its fresh lifetime (clock +61 s) but inside the stale window, **When** 100 reads arrive concurrently, **Then** all answer `200` immediately with the stored value (without waiting for the database), exactly one background refresh runs, and the next read returns the refreshed value; **Given** the clock beyond the stale window (+361 s), **Then** the read is a miss and loads synchronously.
9. **AS-31** (negative caching) — **Given** a well-formed ID that does not exist, **When** it is read twice within 10 s, **Then** both answer `404` and the database is hit once; **When** read after the negative lifetime (clock +13 s, beyond jitter), **Then** the database is hit again; **Given** the ID is later created by the write path or restored (AS-17), **Then** the negative entry is gone (AS-39, AS-40).
10. **AS-32** (read rate limit, penetration) — **Given** the read policy of 600 detail reads per minute per client address, **When** one address sends 700 reads of random well-formed IDs in one minute, **Then** the first 600 answer `404` (the database was hit at most once per distinct ID) and the rest answer `429 rate_limited` with `Retry-After`; other addresses are unaffected.
11. **AS-33** (limiter store down) — **Given** the rate limiter's store is unreachable, **When** anyone reads a product, **Then** the read is served (fail open); the failure is logged and counted.
12. **AS-34** (cache down, fallback) — **Given** the shared cache is unreachable or hanging (fault injected in front of the real cache), **When** a product is read, **Then** the answer is `200` from the database within 2 s (each cache call has a 250 ms timeout), identical in body to a cached answer, no `5xx`, no view is counted, the degraded outcome is counted and logged; **When** the cache returns, **Then** the next read repopulates it. The same holds for a write: `PATCH` answers `200` while the cache is down (AS-40 then guarantees the later invalidation).
13. **AS-35** (database down, warm cache) — **Given** a product whose entry is in the cache and an unreachable database, **When** it is read, **Then** `200` from the cache (including a refresh attempt that fails quietly while the entry is inside its stale window); **Given** a cold product, **Then** `503` problem+json whose `detail` is generic (no SQL, host, stack or driver message) and which carries `requestId`.
14. **AS-36** (hot key) — **Given** two instances `A` and `B` sharing the cache and one product read 200 times within a second on `A`, **Then** after the hot-key detector promotes it, further reads on `A` are served from process memory (the shared cache's `GET` count stays flat, the in-process hit counter rises) and that copy lives at most 1 s; **When** the product is then updated, **Then** within 1 s a read on `A` and a read on `B` both return the new price (the invalidation reaches every instance's process memory).
15. **AS-37** (big keys) — **Given** a product with maximum-size fields (200-character title, 4,000 multi-byte description characters, 32 tags of 50 characters), **When** it is read, **Then** its serialized cache entry is at most 32 KiB; **Given** list and batch reads, **Then** no list is ever stored as one cache entry (only per-product entries exist), and invalidation of an entry uses the non-blocking delete.
16. **AS-38** (batch read for the BFF, R2) — **Given** `GET /batch/products?ids=a,b,c` called anonymously, **When** `a` and `c` are visible and `b` is unknown, archived, of a sandbox shop or of a shop that is not `ACTIVE`, **Then** `200` with an array in request order `[{id, shopId, title, priceMinor, currency, inStock, category, rating}, null, {...}]` (a repeated ID repeats its item), `Cache-Control: public, max-age=10`; cached products are served from their entries and all missing ones are loaded with one statement (100 cold IDs → one statement); more than 100 IDs, none, or a malformed ID answer `400 validation_failed`; the policy of 120 requests per minute per address answers `429` beyond it.

---

### User Story 3 — A price or stock change shows up promptly, and never goes back (Priority: P1)

When a product changes, every cached copy is dropped by the writer and again by an event, so a lost or late message cannot leave a stale price for long, and a late or duplicate message cannot undo a fresh one.

**Why this priority**: a stale price or an "in stock" that is not true costs trust and money.

**Independent Test**: update a product and read it from two instances; deliver the product events twice, out of order, and invalid; make a slow reader write an old value after the delete.

**Acceptance Scenarios**:

1. **AS-39** (delete-on-write) — **Given** a cached product at `version: 3`, **When** a `PATCH`, `archive`, `restore` or any stock change commits, **Then** by the time the response (or the exported command) returns, the product's cache entry is deleted and the write path never stores a value; an immediate `GET /products/P` by anyone returns the committed data (the writer reads its own writes).
2. **AS-40** (event-driven invalidation) — **Given** the writer's own delete failed (cache down during the `PATCH`) and an entry for `version: 3` exists after the cache returns, **When** the consumer of the product events receives `catalog.product_updated` with `productVersion: 4`, **Then** the entry is deleted and the minimum accepted version for the product is recorded as 4; the next read loads version 4; the consumer has its own consumer group, so a slow search projector never delays it.
3. **AS-41** (duplicate event) — **Given** the same event delivered twice with a fresh entry loaded in between, **Then** the second delivery deletes nothing (the cached version is already at least the event's), the metric shows one `applied` and one `skipped`, and no extra miss occurs.
4. **AS-42** (out-of-order events) — **Given** the entry holds `version: 5` or the recorded minimum is 5, **When** an event with `productVersion: 4` arrives late, **Then** it is ignored and the entry or minimum is unchanged.
5. **AS-43** (slow reader race) — **Given** a reader that loaded `version: 3` from the database before the commit of `version: 4`, **When** the invalidation for `version: 4` has been applied and the slow reader then tries to store its `version: 3` value, **Then** the value is not stored (below the recorded minimum) and the next read returns `version: 4`; a stored value of version 4 or higher is accepted.
6. **AS-44** (invalid event) — **Given** an envelope whose `aggregateId` is not a UUID, whose `type` is unknown, or whose payload fails its schema, **When** the consumer receives it (alone or inside a batch), **Then** it is dead-lettered with the reason, no cache entry changes, and the other events of the batch are applied.
7. **AS-45** (coalescing) — **Given** a batch of 10 events about 3 products, **When** the consumer runs, **Then** it issues one invalidation per product, using the highest `productVersion` of that product.
8. **AS-46** (invalidation lag) — **Given** an event with `occurredAt` and a consumer applying it, **Then** the lag histogram records `now − occurredAt` per applied event, and in the test environment the 99th percentile of 100 events is under 5 s.
9. **AS-47** (product deleted event) — **Given** `catalog.product_deleted`, **When** consumed, **Then** the product's entry (positive or negative) is removed unconditionally and the next read answers `404` (and caches that for 10 s).

---

### User Story 4 — Other domains read and change products only through this capability (Priority: P1)

Orders, payments, auctions, imports, the public API and everyone else who needs a product's price or stock ask the catalog; nobody queries or updates its table. Stock never goes negative, and a retried command never counts twice.

**Why this priority**: a double-decremented or negative stock is an oversold or lost sale. The boundary rule (IX.4) is only credible if the exported commands are enough.

**Independent Test**: call the exported services directly from a test module that imports only the catalog's public entry point, with parallel and repeated calls; check rows, outbox and returned values.

**Acceptance Scenarios**:

1. **AS-48** (batch read, R1) — **Given** `ProductQueryService.getProductsByIds(ids)`, **When** called with up to 500 IDs, **Then** it returns a map of `ProductDto` (including `ARCHIVED` products with their `status`, and `quantity`, `version`, `viewCount`, `isSandbox`, `externalSku`), unknown IDs are absent, duplicates collapse, and exactly one statement is issued; an empty list returns an empty map without a statement; 501 IDs or a non-UUID is refused with a validation error.
2. **AS-49** (source of truth) — **Given** a stale public entry for `P` in the cache (the row was changed by a fixture without an event), **When** `getProductsByIds([P])` is called, **Then** it returns the current row (price and stock are never taken from the cache) while `GET /products/P` still serves the stale entry until it is invalidated or expires.
3. **AS-50** (tenant predicate) — **Given** products of shops `A` and `B`, **When** `getProductsByIds(ids, {shopId: A})` is called with IDs from both, **Then** only `A`'s are returned (the others are absent as if unknown).
4. **AS-51** (stock delta applied) — **Given** `P` with `quantity: 10` at `version: 4`, **When** `ProductStockService.applyStockDelta([{operationId:"o1", productId:P, shopId:S, delta:-3, reason:"checkout"}])`, **Then** it returns `{outcome:"applied", results:[{operationId:"o1", productId:P, quantityAfter:7, productVersion:5, replayed:false}]}`; the row has `quantity: 7`, `version: 5`; one stock-operation record and one outbox row `catalog.product_updated` (`changedFields: ["quantity"]`, `inStock` correct) were written in the same transaction; the cache entry is deleted (AS-39).
5. **AS-52** (insufficient stock, atomic) — **Given** `P` with `quantity: 2` and `Q` with `quantity: 9`, **When** one call carries `-3` on `P` and `-1` on `Q`, **Then** it returns `{outcome:"rejected", failures:[{operationId, productId:P, code:"insufficient_stock"}]}` and neither product changed, no operation record or event was written.
6. **AS-53** (no oversell) — **Given** `P` with `quantity: 5`, **When** 10 calls of `-1` with distinct operation IDs run at the same moment, **Then** exactly 5 are applied and 5 are rejected `insufficient_stock`, the final `quantity` is `0`, `version` rose by exactly 5, and exactly 5 events were written; **When** two calls of `-3` on `quantity: 5` run at the same moment, **Then** exactly one is applied (final `2`).
7. **AS-54** (idempotent replay) — **Given** `o1` was applied, **When** the identical operation is sent again (also after the first response was lost), **Then** it returns `replayed: true` with the originally recorded `quantityAfter`, and `quantity`, `version`, outbox and operation records are unchanged; **When** `o1` is sent with another `productId`, `shopId` or `delta`, **Then** it throws `StockOperationConflictError` and nothing changes.
8. **AS-55** (concurrent replay) — **Given** `o1` not yet applied, **When** two identical calls run at the same moment, **Then** exactly one applies it and the other returns `replayed: true`; the stock changed once.
9. **AS-56** (unavailable and foreign) — **Given** an `ARCHIVED` product, **When** a negative delta is applied, **Then** `code: "unavailable"` and no change; **When** a positive delta (a release or refund) is applied, **Then** it is accepted; **Given** a `productId` that does not exist or whose `shopId` differs from the one passed, **Then** `code: "not_found"` and no change.
10. **AS-57** (stock input limits) — **Given** `applyStockDelta`, **When** called with 0 operations, more than 100, a `delta` that is `0`, fractional or beyond ±1,000,000, an `operationId` empty or longer than 128 characters, a `reason` outside `[a-z0-9._-]{1,64}`, the same `operationId` twice in one call, or a result that would exceed `quantity: 1000000000`, **Then** a validation error (or `code: "quantity_limit"` for the last) is returned and nothing changes.
11. **AS-58** (storage backstop) — **Given** the product table, **When** a fixture writes `quantity = -1` directly or two products with the same `(shopId, externalSku)`, **Then** the database refuses both (a check constraint and a unique constraint), independently of application code.
12. **AS-59** (delta rule, pure) — **Given** a quantity `q` in `[0, 1e9]` and a delta `d`, **When** the rule is applied, **Then** it yields `q + d` when that is within `[0, 1e9]` and a rejection otherwise (table-driven for the edges: `0`, `1e9`, `-q`, `-q-1`, `1e9-q+1`); **Given** any generated sequence of deltas applied one by one, **Then** the accepted prefix sums never go below zero or above `1e9` (property-based).
13. **AS-60** (external upsert) — **Given** shop `S` and `ProductImportService.upsertFromExternal(S, items, "import")` with a new `externalSku`, **When** called, **Then** it returns `{externalSku, productId, outcome:"created", productVersion:1}` and one `catalog.product_created` was written; **When** called again with the identical item, **Then** `outcome:"unchanged"`, `version` unchanged, no row write, no event; **When** called with a changed price, **Then** `outcome:"updated"`, `version` +1 and one `catalog.product_updated` listing the changed fields.
14. **AS-61** (concurrent upsert) — **Given** a new `externalSku` in shop `S`, **When** two calls upsert it at the same moment, **Then** exactly one product exists for `(S, externalSku)` (one `created`, the other `updated` or `unchanged`), with no unique-violation error reaching the caller.
15. **AS-62** (per-item results) — **Given** a call with 3 valid items and 2 invalid (price `0`, title of 201 characters), **Then** the valid ones are applied in one transaction and returned, and the invalid ones come back `outcome:"rejected"` with `errors:[{field, code}]` (the source for S07's error report), without failing the call; more than 500 items or an empty list is a validation error.
16. **AS-63** (upsert rules) — **Given** an existing `ARCHIVED` product matched by `externalSku`, **When** upserted, **Then** its fields update but it stays `ARCHIVED`; **Given** an item without `quantity`, **Then** stock is untouched; **Given** the same `externalSku` in shops `A` and `B`, **Then** two products exist; **Given** shop `S` is not `ACTIVE` or does not exist, **Then** the call throws `ShopNotActiveError` before any write.
17. **AS-64** (command parity, R1) — **Given** `ProductCommandService` (`create`, `update`, `archive`, `restore`, `listByShop`, `getForShop`) called by another domain on behalf of shop `S`, **When** it updates a product with a stale version or a foreign shop's product, **Then** it throws the same errors as AS-10 and AS-12, and a successful call writes the same row, version and event as the HTTP route (the HTTP controllers call these services and nothing else).
18. **AS-65** (operation retention) — **Given** stock-operation records older than 30 days (frozen clock), **When** the purge job runs, **Then** they are deleted (at most 5,000 per run, oldest first) and younger ones are kept; replaying a purged `operationId` is treated as a new operation (documented limit).

---

### User Story 5 — View counts are cheap and approximately right (Priority: P2)

Every product page view is counted, but the database sees one batched write every few seconds, not one per view.

**Why this priority**: it is the write-behind showcase, and it keeps the hottest read path free of database writes.

**Independent Test**: serve views, run the flush, break the database during a flush, run two flushes at once, and compare the stored count with the number of views served.

**Acceptance Scenarios**:

1. **AS-66** (count and flush) — **Given** a product with `viewCount: 0`, **When** 5 detail reads are served (`200` or `304`) and the flush job runs, **Then** the stored `viewCount` is 5, the pending counter for the product is empty, and `version`, `updatedAt` and the cache entry are unchanged; the public view shows 5 once the entry is refreshed (the displayed count may lag by the cache lifetime).
2. **AS-67** (flush failure) — **Given** 5 pending views and a database that fails the flush (a trigger raising an error), **When** the job runs, **Then** it fails visibly (logged, counted), the 5 are put back, and after the fault is removed the next flush stores exactly 5 (never 0, never 10).
3. **AS-68** (views during a flush) — **Given** reads running while a flush drains, **When** both finish and one more flush runs, **Then** the stored total equals the number of views served (increments arriving mid-flush belong to exactly one flush).
4. **AS-69** (chunks) — **Given** 2,500 products with pending views, **When** the job runs, **Then** it applies them in at most 1,000 products per statement (3 statements); **Given** the second statement fails, **Then** only the second and third chunks are put back, the first stays applied, and the next run applies the rest exactly once.
5. **AS-70** (deleted product) — **Given** a pending view for a product that no longer exists, **When** the job runs, **Then** it is dropped without error and every other delta is applied.
6. **AS-71** (two workers) — **Given** two flush runs at the same moment (a duplicated schedule), **Then** each pending delta is applied exactly once.
7. **AS-72** (cache down) — **Given** the shared cache is down, **When** a product is read (AS-34), **Then** the read succeeds and the view is simply not counted; the failure is logged and counted, and no error reaches the caller.
8. **AS-73** (what is not counted) — **Given** `404`, `400` and `429` answers, hidden products (AS-25) and batch reads, **Then** none is counted.
9. **AS-74** (no write amplification) — **Given** a flush that changed 100 products' counts, **Then** it wrote no outbox row, published no event and invalidated no cache entry, and each product's `version` is unchanged.
10. **AS-75** (schedule) — **Given** the job `products.flush-view-counts` registered with the scheduler every 10 seconds, **Then** it runs once per tick across replicas and is idempotent (AS-71).

---

### User Story 6 — The catalog follows the shop's life (Priority: P2)

When a shop is suspended its products disappear from the public pages; when it is reinstated they come back; when it is deleted its products are deleted; legacy products get their shop.

**Why this priority**: the tenancy contract (S03) makes every shop-owning domain react to these events, and visibility of a suspended shop's goods is a trust and safety matter.

**Independent Test**: deliver the shop events to the catalog's consumers and run the backfill; read public pages and the table before and after.

**Acceptance Scenarios**:

1. **AS-76** (suspension hides products) — **Given** an `ACTIVE` shop `S` with 2,500 products (entries cached), **When** `tenancy.shop_status_changed {from:"ACTIVE", to:"SUSPENDED", shopVersion:5}` is consumed, **Then** the catalog's copy of the shop's status is `SUSPENDED` at `shopVersion: 5`, every cached entry of the shop's products is dropped in bounded batches (at most 1,000 per batch), and `GET /products/P` and the batch read answer `404` / `null`; **When** the reinstating event (`to: "ACTIVE"`, `shopVersion: 6`) is consumed, **Then** the products are visible again; an event with `shopVersion` not above the stored one is ignored.
2. **AS-77** (shop purge) — **Given** `tenancy.shop_deleted {shopId: S}`, **When** consumed, **Then** all products of `S` are deleted in transactions of at most 500 rows, each deleted product's stock-operation and status-history rows go with it, `catalog.product_deleted` is written for each (with `productVersion` one above its last), their cache entries are removed, and the status copy for `S` is deleted; products of other shops are untouched; delivering the event again changes nothing; the job resumes from where it stopped if interrupted.
3. **AS-78** (invalid shop events) — **Given** a shop event whose payload fails its schema (missing or non-UUID `shopId`, unknown `to` status, non-integer `shopVersion`), **When** consumed, **Then** it is dead-lettered without side effects and later events are processed.
4. **AS-79** (shop-id backfill) — **Given** legacy products with no `shopId` and a `createdBy`/seller, **When** the backfill job runs, **Then** it obtains shops through `ShopProvisioningService.ensureShopsForLegacySellers` for at most 200 sellers per call, assigns `shopId` in batches (never one transaction over all rows), writes one `catalog.product_updated` (`changedFields: ["shopId"]`) per product, can be interrupted and run again without effect on finished rows, and running it twice concurrently assigns each product once.
5. **AS-80** (ownership constraints) — **Given** the finished backfill, **Then** the database refuses a product without `shopId` (the contract step: constraint added unvalidated, validated, then `NOT NULL`, with a lock timeout on each step) and the product table has no foreign key to the shop table or the user table (cross-domain references are plain identifiers).
6. **AS-81** (sandbox shops) — **Given** a product created in a sandbox shop, **Then** `isSandbox` is stamped from the shop summary read at creation (one batch lookup through `ShopQueryService`, outside the transaction), every event carries `isSandbox: true`, and the product is never visible publicly (AS-25).

---

### User Story 7 — The product's contract with the rest of the system is exact (Priority: P3)

The events, the exported services and the storage boundary are specified tightly enough that other capabilities can build on them without reading this domain's code.

**Why this priority**: it is what keeps the catalog replaceable and the other domains honest.

**Independent Test**: parse every event with the contracts schemas, force failures between product and outbox writes, run the static checks.

**Acceptance Scenarios**:

1. **AS-82** (event contract) — **Given** any product change of AS-01, AS-07, AS-16, AS-17, AS-51, AS-60, AS-77 and AS-79, **Then** the outbox row carries topic `products.events`, `aggregateId = productId` (so one product's events are ordered), `type`, `version: 1`, `eventId`, `occurredAt` and a payload that parses with `productEventSchemas`; `productVersion` strictly increases by 1 for each event of one product; a committed change that changes nothing (AS-09, AS-60 unchanged) writes no event.
2. **AS-83** (atomicity with the outbox) — **Given** a fault that makes the outbox insert fail (a trigger), **When** a product is created, updated, archived or stock-adjusted, **Then** the whole transaction rolls back (no row change, no history, no operation record) and the caller gets `503` (HTTP) or the error (R1); no cache entry was deleted for a change that did not commit.
3. **AS-84** (timeouts) — **Given** the product table is locked for longer than the 2 s read timeout, **When** a cold product is read, **Then** `503` problem+json within 3 s (it does not hang), while warm entries are still served (the 250 ms cache-call timeout is AS-34).
4. **AS-85** (observability) — **Given** a product read, a write and a flush, **Then** every log line carries `requestId`/`traceId` and no field holds credentials, e-mail addresses or request bodies; the metrics `catalog_product_read_total{outcome=hit|stale|miss|negative|degraded|l1}`, `catalog_product_invalidation_total{result=applied|skipped|dead_lettered}`, `catalog_product_invalidation_lag_seconds`, `catalog_view_flush_total{result}`, `catalog_view_flush_pending`, `catalog_stock_operation_total{result}` exist and move as the scenarios above describe; every problem+json carries `type`, `title`, `status`, `detail`, `instance`, `requestId` and a `code`.
5. **AS-86** (boundary, static) — **Given** the repository, **When** `pnpm --dir packages/backend check:table-ownership --strict` runs, **Then** it reports zero findings for `catalog` (no query touching another domain's table, no injected foreign model, no association to another owner) and zero findings anywhere for `Product`; **When** `check:boundaries` runs, **Then** no other domain imports `catalog` internals, the public entry point exports no model, no repository, no projector or consumer class and no search class, and `catalog` imports no `discovery` or search-engine code.
6. **AS-87** (removed search routes) — **Given** an application that loads only the catalog's modules, **When** `GET /products/search` or `GET /shops/S/products/search` is requested, **Then** `404`; search is served by S32.

### Edge Cases

- A product edited by a seller while checkout decrements its stock: the seller's `PATCH` carries an old `expectedVersion` and gets `409` with the current version (AS-10); the reverse never loses a decrement because stock changes are conditional updates (AS-53).
- A stock release arrives for a product archived in the meantime: positive deltas are accepted (AS-56).
- Two sellers create the same title at once: allowed; titles are not unique (only `(shopId, externalSku)` is).
- A product edit commits while its page is being recomputed: the slow reader cannot resurrect the old version (AS-43).
- The invalidation event is lost entirely: the entry still dies at its lifetime; the worst case a shopper can see is 6 minutes old (60 s fresh + 300 s stale window); normally under 5 s.
- A price changes while a page is cached at a CDN: the CDN may serve the old price for at most 45 s (`s-maxage` 15 + stale window 30); checkout always charges the database price (AS-49).
- A shop is suspended during a flash of traffic: its pages disappear within the batch time of AS-76, and any entry still cached expires within its lifetime.
- A very large shop (50,000 products) is suspended or deleted: work is done in bounded batches and never as one statement or transaction (AS-76, AS-77).
- Unicode titles and tags are stored as sent (after trimming and, for tags, lower-casing); length limits count Unicode code points.
- A product ID reused after deletion cannot happen: identifiers are time-ordered UUIDs generated on the server.

## Requirements *(mandatory)*

### Functional Requirements

**Products and who may change them**

- **FR-001**: A product belongs to exactly one shop for its whole life, is created `ACTIVE` at `version: 1`, and records the user who created it; the shop and creator are never taken from the request body (AS-01, AS-02).
- **FR-002**: Input is validated strictly: unknown fields are refused; text lengths, price bounds (`1…10,000,000,000` minor units), stock bounds (`0…1,000,000,000`), tag rules and the platform-currency rule are exactly those of AS-02 and AS-03; tags are normalised (AS-01); `rating`, `viewCount`, `status`, `version`, `externalSku` and `isSandbox` are never writable through the HTTP routes.
- **FR-003**: Money is an integer in minor units with an explicit currency, never a float; the only supported currency is the platform's (AS-03).
- **FR-004**: Every write route requires a signed-in member of the shop with `products.write`; reads of one product and the list require `products.read`. Answers follow S03's order: `401`, then `404`, then `403 permission_denied`, then the status gate (`403 shop_suspended`, `409 shop_offboarding`) (AS-04, AS-05, AS-13).
- **FR-005**: Every lookup of a product by a member puts the shop in the predicate; a product of another shop is indistinguishable from an unknown one (`404 product_not_found`) (AS-12, AS-50).
- **FR-006**: Updates, archive and restore require `expectedVersion`; they succeed only when it equals the current version, as one conditional update that asserts one affected row; a mismatch is `409 version_conflict` carrying `currentVersion`; of simultaneous requests with the same version exactly one succeeds (AS-07, AS-10, AS-11, AS-20).
- **FR-007**: A change whose values equal the stored ones writes nothing and emits nothing (AS-09, AS-60).
- **FR-008**: The lifecycle is `ACTIVE ⇄ ARCHIVED` only. Each transition is a conditional update plus a status-history row in the same transaction; an illegal transition is `409 invalid_transition`; archived products cannot be edited (`409 product_archived`); there is no hard delete through the API (AS-16–AS-21).
- **FR-009**: The member list is a keyset page (`createdAt` descending, `id` descending), opaque cursor bound to shop and filters, `limit` 1–100 (default 20), filters `status`, `category`, `inStock`; offset pagination does not exist (AS-14, AS-15).
- **FR-010**: Responses are explicit views, never stored rows: a **member view** (for members) and a **public view** (for everyone); neither carries internal fields (AS-01, AS-23).
- **FR-011**: Writes are rate limited per shop (120/minute) and fail closed when the limiter is unavailable (AS-22).

**Public read and cache**

- **FR-012**: The public product read is cache-aside: look in process memory (only for detected hot keys), then the shared cache, then load from the database and store; the shared cache is never the source of truth (AS-27).
- **FR-013**: A product is publicly visible only while it is `ACTIVE`, belongs to a non-sandbox shop whose catalog-side status is not `SUSPENDED`, `DELETING` or `DELETED`; everything else answers the same `404` as an unknown product (AS-25, AS-76).
- **FR-014**: A malformed identifier is rejected before any cache or database access (AS-26).
- **FR-015**: Entries have a fresh lifetime of 60 s and a stale window of 300 s, each with ±10% jitter; every entry has a lifetime; entries serialize to at most 32 KiB, which the field limits of FR-002 guarantee; no list is stored under one key (AS-28, AS-37).
- **FR-016**: Entries past their fresh lifetime are served once while exactly one refresh runs in the background (stale-while-revalidate); entries past the stale window are misses (AS-30).
- **FR-017**: Concurrent misses for one product share one load per instance and, across instances, one load guarded by a short lock, with followers waiting briefly and then computing themselves if the holder is slow or dead (AS-29).
- **FR-018**: "Not found" is cached for 10 s (±10%) so made-up identifiers cannot hammer the database; reads are rate limited per address (600/minute), failing open (AS-31, AS-32, AS-33).
- **FR-019**: Hot products are promoted to process memory with a lifetime of at most 1 s; invalidation reaches every instance's process memory (AS-36).
- **FR-020**: If the shared cache is unreachable or slow (250 ms per call) the read falls back to the database, single-flighted, and the view is not counted; if the database is unreachable a warm entry (including one inside its stale window) is still served, otherwise `503` with a generic detail; the database read has a 2 s timeout (AS-34, AS-35, AS-84).
- **FR-021**: The public response carries `ETag: W/"<id>-v<version>"` and honours `If-None-Match` with `304`; `Cache-Control: public, s-maxage=15, stale-while-revalidate=30` on `200`, `s-maxage=5` on `404` (AS-23, AS-24, AS-25).
- **FR-022**: The BFF batch read returns up to 100 products in request order with `null` for the invisible, serves hits from the same entries, loads misses with one statement, is rate limited (120/minute/address) and is the only catalog read the BFF composes (R2) (AS-38).

**Invalidation**

- **FR-023**: Writes delete the product's entry after commit and never write it; a failed delete never fails the write (AS-39, AS-34).
- **FR-024**: A dedicated consumer of the product events deletes the entry again, so a lost writer-side delete is repaired; it has its own consumer group (AS-40).
- **FR-025**: Entries carry the product `version`. Invalidation by event deletes the entry only when its cached version is below the event's, and records the event's version as the minimum acceptable for that product for the length of the stale window; a value below the recorded minimum is not stored. Duplicate and out-of-order events therefore change nothing (AS-41, AS-42, AS-43).
- **FR-026**: The consumer validates every envelope and payload; an invalid one is dead-lettered without effect and without blocking the batch; a batch is coalesced to one invalidation per product (AS-44, AS-45).
- **FR-027**: Invalidation lag (event `occurredAt` to applied) is measured and normally under 5 s at the 99th percentile (AS-46).
- **FR-028**: A deleted product's entry is removed unconditionally (AS-47).

**Exported commands (R1)**

- **FR-029**: Price and stock are read by other domains only through `getProductsByIds`, which reads the database (never the cache), returns DTOs, issues one statement, and accepts an optional shop filter (AS-48–AS-50).
- **FR-030**: Stock is changed by other domains only through `applyStockDelta`: all-or-nothing per call, one conditional update per item that cannot take stock below zero, idempotent by `operationId`, never outside the item's shop, with negative deltas refused on archived products (AS-51–AS-57).
- **FR-031**: Stock can never be negative or above 1,000,000,000 whatever the code does: a check constraint says so in storage (AS-58).
- **FR-032**: Externally sourced products are written only through `upsertFromExternal`, keyed by `(shopId, externalSku)`, with per-item results, change detection and no resurrection of archived products (AS-60–AS-63).
- **FR-033**: Other domains create, update, archive, restore and list products only through `ProductCommandService`, which the HTTP controllers also use, so one path enforces every rule (AS-64).
- **FR-034**: Stock-operation records are kept 30 days and purged by a scheduled job (AS-65).

**Views**

- **FR-035**: A view is counted for each `200`/`304` public read of a visible product, in the shared cache, not the database; counting never fails or slows the read (AS-66, AS-72, AS-73).
- **FR-036**: A scheduled job every 10 s takes the pending counts atomically and adds them to `viewCount` in at most 1,000 products per statement; failures put the unapplied counts back; two concurrent runs apply each count once; flushing changes no `version`, publishes no event and invalidates no entry (AS-66–AS-71, AS-74, AS-75).
- **FR-037**: View counts are approximate by design: up to one flush interval of counts can be lost if the shared cache loses data; they are never used for money.

**Shop lifecycle and boundaries**

- **FR-038**: The catalog keeps a copy of each shop's status (version-guarded by `shopVersion`) from `tenancy.shop_status_changed`, and drops the affected cached entries in bounded batches (AS-76).
- **FR-039**: On `tenancy.shop_deleted` the catalog deletes the shop's products and dependent rows in bounded transactions, emits `catalog.product_deleted`, and is idempotent and resumable (AS-77, AS-78).
- **FR-040**: The catalog assigns shops to legacy products through `ShopProvisioningService` in batches, owns the not-null contract step, and holds no foreign key to another domain's table (AS-79, AS-80).
- **FR-041**: Sandbox products are flagged at creation and never public (AS-81).
- **FR-042**: Every committed change writes exactly one versioned product event, in the same transaction, carrying a full snapshot of the product so consumers keep copies (IX.8) and never read the table (AS-82, AS-83).
- **FR-043**: The catalog reads no table it does not own and exports no model, repository, projector or search class; search leaves the domain (AS-86, AS-87).
- **FR-044**: Logs, metrics and error bodies follow AS-85.

### Key Entities *(include if feature involves data)*

- **Product**: `{id, shopId, createdBy, title, description, brand, category, priceMinor, currency, rating (read-only), tags, quantity, status (ACTIVE|ARCHIVED), version, viewCount, isSandbox, externalSku?, createdAt, updatedAt}`. Owned by `catalog`; `(shopId, externalSku)` unique; `quantity` between 0 and 1,000,000,000.
- **Product status history**: `{productId, from, to, actorId, at}`, written with every status change.
- **Stock operation**: `{operationId (unique), productId, shopId, delta, reason, quantityAfter, productVersion, appliedAt}`; kept 30 days.
- **Shop listing state**: catalog's copy `{shopId, status, shopVersion}` of what it needs from the shop (IX.8, R3).
- **Product cache entry**: the public view plus its version; one per product; negative entries for "not found".
- **Pending view counts**: per product, in the shared cache, until flushed.
- **Product event**: `catalog.product_created|updated|archived|restored|deleted` (see Provides).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a matrix of every shop-scoped product route against every role of the same shop and every role of another shop, 100% of cross-shop attempts answer the same "not found" and change nothing.
- **SC-002**: Of 1,000 randomized concurrent stock decrements against 100 units, exactly 100 are accepted, the stock never goes below zero at any observed moment, and replaying every request a second time changes nothing.
- **SC-003**: Of 100 simultaneous first views of one product, exactly 1 reaches the database; of 100 views arriving while its entry is stale, 100 are answered without waiting for the database.
- **SC-004**: After a seller changes a price, 99% of product pages show the new price within 5 seconds and 100% within 6 minutes even if the change notification is lost; a late or repeated notification never brings back an old price.
- **SC-005**: With the shared cache completely unavailable, 100% of product page reads of existing products still succeed (from the database) within 2 seconds.
- **SC-006**: A flood of 1,000 requests for products that do not exist causes at most one database lookup per distinct identifier and is refused beyond 600 requests per minute from one address.
- **SC-007**: After 10,000 views of one product, the database received at most one count write per 10 seconds for that product, and the stored count equals the number of views served (absent a crash of the cache).
- **SC-008**: A seller can list a new product and see it in their inventory in under 2 minutes of interaction.
- **SC-009**: The ownership check reports 0 cross-domain queries, models or associations for the catalog and 0 queries against the product table from any other domain.
- **SC-010**: Re-running any stock command, import batch, invalidation event or shop event a second time changes nothing in 100% of the cases tested.

## Assumptions

- A seller's right to list is decided by shop membership and role (S03); verification (S04) gates payouts, not listing; product-count limits per plan belong to S18 and are not enforced here.
- One platform currency exists in this release; the `currency` field is stored and returned so more can be added later without a contract change.
- `rating` has no writer in this release (reviews are not a capability yet); it is kept at 0 and is read-only here.
- Product creation is not idempotent by header (the constitution requires `Idempotency-Key` only for orders, payments, bookings, bids and ledger movements); duplicate listings are removable by archiving.
- A product's description, title and tags are plain text; rendering safety is the client's job (VI.7).
- Embeddings and the full-text vector belong to the search capability (S32); the catalog neither stores nor serializes them after this release.
- A stock change bumps `version` like every other change; sellers who edit while sales happen retry on `409` (a finer per-field merge is not worth the complexity).
- Freshness numbers (60 s, 300 s, 10 s, 15 s, 45 s) and sizes (32 KiB, 1,000 per batch) are defaults chosen for a product catalog ("minutes of staleness acceptable", note 03/04 §9); they are configuration, not contract.
- The decisions behind every default are listed in `questions.md`; the ones that change behaviour that exists today are tagged `[BREAKING]` there.

## Cross-capability contracts

Earlier specs searched (`grep` over `specs/domains` for `S05` and `catalog`; `specs/web` and `specs/journeys` do not exist yet): **S03** requires from S05 that it runs its own shop-id backfill with `ShopProvisioningService.ensureShopsForLegacySellers` (≤ 200 sellers per call), drops its foreign keys to the shop and user tables and its raw reads of tenancy tables, and reacts to `tenancy.shop_offboarding_started` and `tenancy.shop_deleted` (honoured: AS-77, AS-79, AS-80; the offboarding export is a `[CONTRACT]` question). S01, S02 and S04 name no S05 contract (S04's "catalog" is a questionnaire step). Everything below is new and is read by later specs.

**Provides** (exact names; exported from `@app/domains/catalog` unless it is an HTTP endpoint):

- HTTP under `/api`, problem+json errors with `code`, schemas in `packages/contracts` (`productMemberSchema`, `productPublicSchema`, `productBatchItemSchema`, `productCreateRequestSchema`, `productUpdateRequestSchema`, `productTransitionRequestSchema`, `productPageSchema` = `{items, nextCursor}`, `productEventSchemas`):
  - `POST /shops/:shopId/products` (`products.write`) → `201 productMemberSchema`; `GET /shops/:shopId/products?status&category&inStock&limit&cursor` (`products.read`) → `productPageSchema`; `GET /shops/:shopId/products/:productId` (`products.read`) → `productMemberSchema`; `PATCH /shops/:shopId/products/:productId {expectedVersion, title?, description?, brand?, category?, priceMinor?, currency?, quantity?, tags?}` → `200 productMemberSchema`; `POST /shops/:shopId/products/:productId/archive {expectedVersion}` and `.../restore {expectedVersion}` → `200 productMemberSchema`.
  - `GET /products/:productId` (anonymous) → `productPublicSchema` with `ETag`; `GET /batch/products?ids=` (anonymous, ≤ 100 ids; the BFF's R2 target, S48) → array of `productBatchItemSchema | null`.
  - Removed: `POST /products`, `POST /products/shops/:shopId`, `GET /products/search`, `GET /shops/:shopId/products/search` (the last two move to S32).
- `ProductQueryService` (R1): `getProductsByIds(ids: ProductId[], options?: { shopId?: ShopId }): Promise<Map<ProductId, ProductDto>>` (≤ 500; reads the database; one statement); `ProductDto = { id, shopId, title, description, brand, category, priceMinor, currency, rating, tags, quantity, inStock, status: 'ACTIVE' | 'ARCHIVED', isSandbox, externalSku: string | null, version, viewCount, createdAt, updatedAt }`. **Consumers: S10, S11, S13, S21 (price and stock), S42 (replaces public-catalog SQL), S46 and S47 (assistant tools, knowledge ownership), S24 (chat channel product lookup), S29, S31, S41, S36 (ownership: pass `{shopId}`), S34, S35, S32 (popularity refresh from `viewCount`).**
- `ProductStockService` (R1): `applyStockDelta(ops: StockOperation[]): Promise<ApplyStockResult>` with `StockOperation = { operationId: string (1–128), productId: ProductId, shopId: ShopId, delta: number (non-zero integer, |delta| ≤ 1,000,000), reason: string ([a-z0-9._-]{1,64}) }` (1–100 per call, distinct IDs); `ApplyStockResult = { outcome: 'applied', results: { operationId, productId, quantityAfter, productVersion, replayed }[] } | { outcome: 'rejected', failures: { operationId, productId, code: 'insufficient_stock' | 'unavailable' | 'not_found' | 'quantity_limit' }[] }`; throws `StockOperationConflictError`. Guarantees: all-or-nothing, never below zero, idempotent per `operationId` for 30 days. Compensation is a new operation with the opposite delta and its own `operationId`. **Consumers: S10, S11 (reconciliation), S13, S21, S08 and S09 (stock sync), S42 (stock updates).**
- `ProductImportService` (R1): `upsertFromExternal(shopId: ShopId, items: ExternalProductInput[], source: 'import' | 'shopify' | 'woocommerce' | 'offline'): Promise<ExternalUpsertResult[]>`; `ExternalProductInput = { externalSku (1–128), title, description, brand, category, priceMinor, quantity?, tags? }` (1–500 per call); `ExternalUpsertResult = { externalSku, productId?, outcome: 'created' | 'updated' | 'unchanged' | 'rejected', productVersion?, errors?: { field, code }[] }`; throws `ShopNotActiveError`. **Consumers: S07, S08, S09.** Their conflict rules (field clocks, links, cursors) stay with them; they never write the product table or `products.events`.
- `ProductCommandService` (R1): `create(shopId, actorId: UserId, input)`, `update(shopId, productId, input & { expectedVersion })`, `archive(shopId, productId, expectedVersion, actorId)`, `restore(...)`, `listByShop(shopId, query)`, `getForShop(shopId, productId)` returning the member view; throws `ProductNotFoundError`, `VersionConflictError`, `InvalidTransitionError`, `ProductArchivedError`, `ShopNotActiveError`. **Consumers: S42 (public API), S06 (publish applies a revision through `update`), S46 (assistant is read-only and does not use it).**
- Events (outbox → topic `products.events`, key `productId`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; payload of `created|updated|archived|restored`: `{productId, shopId, title, description, brand, category, priceMinor, currency, rating, tags, quantity, inStock, status, isSandbox, externalSku, productVersion, createdAt, updatedAt, changedFields: string[]}` (`changedFields` empty on `created`); payload of `deleted`: `{productId, shopId, productVersion}`): `catalog.product_created`, `catalog.product_updated` (also for stock changes), `catalog.product_archived`, `catalog.product_restored`, `catalog.product_deleted`. `productVersion` is the entity version for read-model guards (IX.8). View counts are never in events. **Consumers: S32 (index projector, moves here from this domain), S19 (pickup availability), S25/S26 (product feed), S43 (webhook router: `product.*` events), S40 (sales and leaderboards read `shopId` and price from the snapshot), S24, S34, S35, S36.**
- Modules for the apps: `ProductModule` (core: HTTP, R1 services), `ProductBatchReadModule` (core: the batch route), `ProductWorkerModule` (worker: view flush, operation purge, shop-id backfill), `ProductProjectorModule` (projector: cache invalidator, shop-event consumers). Nothing else is exported (no model, repository, projector or search class).
- Rate-limit policies (declared in S50's registry): `catalog.product-read.ip` 600/minute per address (fail open); `catalog.product-write.shop` 120/minute per shop (fail closed); `catalog.batch-read.ip` 120/minute per address (fail open).
- Scheduled jobs (registered with S49): `products.flush-view-counts` (every 10 s, concurrency 1), `products.purge-stock-operations` (daily), `products.backfill-shop-ids` (resumable; runs until no legacy product is left).

**Requires**:

- **S03** (`tenancy`): `ShopScoped(permission)` with `products.read` and `products.write` and the status gate of AS-12 of S03 (`403 shop_suspended`, `409 shop_offboarding`); `ShopQueryService.getShopsByIds(ids ≤ 500): Map<ShopId, ShopSummaryDto>` with `status`, `isSandbox`, `shopVersion` (R1; used at create and for the active check; `TenancyModule` must be loaded in every app that hosts catalog write services); `ShopProvisioningService.ensureShopsForLegacySellers(sellerIds ≤ 200): Map<UserId, ShopId>`; events `tenancy.shop_status_changed` v1 `{shopId, from, to, reason?, shopVersion}` and `tenancy.shop_deleted` v1 `{shopId}`.
- **S52** (`infrastructure/cache`): `getOrLoad(key, loader, { ttlMs, swrMs, negativeTtlMs, l1 })` with single-flight, lock, stale-while-revalidate, jitter, negative entries, hot-key promotion, degradation; `invalidate(keys)` with broadcast to every instance's memory; **additions asked for (see `questions.md`)**: entries that carry a version and a per-key minimum version (`invalidateIfOlder(key, version)`; a store below the minimum is refused), a 250 ms per-call timeout, and the non-blocking delete; `WriteBehindCounter` (`increment`, atomic `drain`, `restore`); `VersionEtagInterceptor`.
- **S53**: `outbox.append(event)` inside the domain's transaction (IX.6); the consumer framework (envelope check, zod validation, coalescing, own consumer group, DLQ, inbox or version guard).
- **S49**: single-run scheduled jobs with leases. **S50**: the policies above. **S54**: problem+json filter with `code`, request context with `requestId`, config validation (platform currency, lifetimes), metrics registry, graceful shutdown.
- **S32**: hosts `GET /products/search` and `GET /shops/:shopId/products/search`, takes over the search projector and the logging of searches, and consumes the events above (never the table). **S06**: publishes revisions through `ProductCommandService.update`. **S07, S08, S09, S10, S11, S13, S21, S42**: use the exported services instead of SQL (replacement table in `gaps.md`).
