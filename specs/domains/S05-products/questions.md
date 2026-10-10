# Open Decisions for S05 (answered unattended)

Format: `[TAG] question → default taken → why`. BREAKING first, then CONTRACT, then LOCAL. The human reviews BREAKING and CONTRACT lines first. Decision policy: most production-grade option the Interview-Prep notes and the constitution support.

## BREAKING (changes behaviour or an API/UI contract that exists today)

- [BREAKING] Product write route (today `POST /products/shops/:shopId`) → `POST /shops/:shopId/products`, with `GET` (list, one), `PATCH`, `archive`, `restore` under the same prefix; `useCreateProduct` and the seller inventory view in `packages/web` change → one REST shape for the shop-scoped resource; V.5 (non-CRUD actions are sub-resources).
- [BREAKING] Shop-less `POST /products` (any signed-in user creates a product with no shop; only `Firewall()`, no role or tenant check) → removed → III.4 and S03: every product belongs to a shop and is written by a member with `products.write`; today it creates orphans that no shop can manage.
- [BREAKING] `GET /products/search` and `GET /shops/:shopId/products/search` leave the catalog (served by S32); `SearchQueryLogger` import from discovery disappears; the search cases of `product.e2e-spec.ts` move to S32 → D-15 (catalog → discovery cycle) and D-16; search is not product CRUD.
- [BREAKING] Money field `price` (cents, `>= 0`) → `priceMinor` (integer `1…10,000,000,000`, so `0` is refused) plus `currency` (platform currency) in every response and event; web and S42 map the name → P0103 (explicit minor units and currency); a free product is not a supported concept and a zero price must not reach a payment intent.
- [BREAKING] Seller-supplied `rating` on create (`CreateProductDto.rating`) → refused, read-only, default 0 → a seller must not set their own rating; no capability writes it yet.
- [BREAKING] Public detail response (today `sellerId`, `quantity`, internal-looking fields) → `{id, shopId, title, description, brand, category, priceMinor, currency, rating, tags, inStock, version, viewCount, updatedAt}`; exact `quantity` only in the member view → V.1 (internal IDs and competitor-scrapable stock levels are not public); `web/lib/api/catalog.ts` `ProductDetail` loses `sellerId` and `quantity`, the seller inventory uses the member view.
- [BREAKING] Create returns the ORM model cast to a DTO (`product as unknown as ProductRawDto`, which leaks `embedding`, `searchVector`, `sellerId`) → explicit member view parsed by `productMemberSchema` → V.1, V.2.
- [BREAKING] Product events (today `{productId}` only: "something changed", consumers re-read the table; written by catalog, catalog-sync, public-api and drafts with raw SQL) → versioned snapshot events `catalog.product_created|updated|archived|restored|deleted` with `productVersion`, `changedFields`, `isSandbox`; only the catalog writes them → IX.7 R3 and IX.8 (event data is copied, so projectors stop reading `Product`); IV.4 (every event has `eventId`, `type`, `version`, `occurredAt`, aggregate ID). Consumers (S32, S19, S25/S26, S43, S40) switch to the snapshot.
- [BREAKING] Optimistic concurrency (today a `version` column that no route checks; `ProductDtoService.update` overwrites blindly) → `expectedVersion` is required on `PATCH`, `archive`, `restore`; mismatch is `409 version_conflict` with `currentVersion` → note 03/02 (OCC) and III.6/III.7; `version` now starts at 1 for new rows (today default 0).
- [BREAKING] Lifecycle (today none; no update, no delete) → `ACTIVE ⇄ ARCHIVED`, no hard delete through the API, archived products are hidden publicly and refuse edits and stock decrements → III.7 (conditional transition plus history row, `409` on illegal transition); a hard delete would break order history that references product IDs (cross-domain, plain IDs).
- [BREAKING] Input limits (today any string; `price` accepts `0` and no maximum; `quantity` unbounded; tags ≤ 32 only) → limits of AS-02, unknown fields refused → V.3 and the "big key" note (03/04 §4): bounded fields bound the cache entry to 32 KiB.
- [BREAKING] Seller product list (today served by discovery's `GET /shops/:shopId/products/search` with raw SQL over `Product`, full-text, no cursor) → catalog's `GET /shops/:shopId/products` with keyset paging and filters; text search inside a shop stays with S32 (R3) → III.10, D-12.
- [BREAKING] Foreign keys `Product.sellerId → User` and `Product.shopId → Shop`, and the `BelongsTo(User)` association → dropped by expand/contract migrations (lock timeout, one step each); `sellerId` is replaced by plain `createdBy`; `shopId` becomes `NOT NULL` after the backfill → IX.4 (S03 already asks for this); `createdBy` replaces the public `sellerId`.
- [BREAKING] `ProductModel`, `ProductDtoService`, `ProductCacheInvalidator`, `ProductSearchProjector` leave the barrel; `getProductsByIds` reads the database, never the cache → D-7, D-8; X.4; price and stock decisions must not rely on a cache that is stale by design.
- [BREAKING] Stock changes by other domains (today raw `UPDATE "Product" SET quantity = …` in orders, payments, auctions, catalog-sync, public-api, and no idempotency) → only `applyStockDelta` with a mandatory `operationId`; all callers change → III.6, note 03/04 §3 ("double submit / retries?"), domain-map R1 exports.
- [BREAKING] `GET /batch/products` (today `skipThrottle`, raw SQL in the controller, returns archived and sandbox products' rows, unbounded ids) → rate limited, cache-assisted, at most 100 ids, invisible products are `null`, `shopId` added → IX.7 R2, I.2/II.1 (controller without queries), S48 consumes it.
- [BREAKING] Public detail headers (today ETag only) → plus `Cache-Control: public, s-maxage=15, stale-while-revalidate=30`, and `404` carries `s-maxage=5` → SD-34 (HTTP caching, CDN SWR), README #23; bounded staleness at the CDN (45 s) is accepted because checkout charges the database price.
- [BREAKING] Product visibility follows shop status (today a suspended or sandbox shop's product is served by the detail route) → hidden (`404`), fed by `tenancy.shop_status_changed`; sandbox products flagged at creation → trust and safety; the search projector filters sandbox only in the index today.
- [BREAKING] Invalidation (today `DEL` on every event, unconditional, a slow reader can restore an old value for a whole lifetime) → version-guarded invalidation with a recorded minimum version, plus writer-side delete after commit → note 03/04 §3 "why delete on write… a race remains… versioned values, short TTLs, delayed double delete"; duplicates and out-of-order events become harmless.
- [BREAKING] View flush (today one statement of any size, no chunking) → chunks of 1,000 products, partial restore → bounded statements; same job name `products.flush-view-counts`.

## CONTRACT (decides something another capability must provide or consume)

- [CONTRACT] S52 cache toolkit → add versioned entries and a per-key minimum version (`invalidateIfOlder`, store refused below the minimum), a 250 ms per-call timeout, `UNLINK` for deletes; S52 keeps owning the toolkit and its tests, S05 owns the product-level proof (AS-39–AS-47) → the notes' "versioned values" mitigation cannot be built in the domain without toolkit support.
- [CONTRACT] S32 → takes over `GET /products/search`, `GET /shops/:shopId/products/search`, the search projector (consumes the snapshot events; reads `isSandbox` from the event, no `Shop` SQL), the query logger, and the `popularity` signal (view counts are not in events: S32 refreshes it from `getProductsByIds(...).viewCount` or its own click logs) → D-15, D-16; a view event per flush would amplify writes.
- [CONTRACT] S10, S11, S13, S21 → use `applyStockDelta` with `operationId` formed as `<service>:<aggregate-id>:<step>`; compensation is a new operation; reservations that must outlive a checkout are their own concern → IV.3 (no cross-domain transaction), IX.4.
- [CONTRACT] S07, S08, S09 → write only through `upsertFromExternal` and `applyStockDelta`; field clocks, links, cursors and quarantine stay in catalog-sync; they stop publishing `products.events` themselves → domain-map ("catalog-sync … never writes `Product` directly").
- [CONTRACT] S42 → uses `ProductCommandService` and `getProductsByIds` in place of its SQL (`public-catalog.service.ts`); its date-pinned DTOs map from the member view → IX.7 R1.
- [CONTRACT] S06 → publishing a draft applies the revision through `ProductCommandService.update` (in-domain call), not `UPDATE "Product"` in `drafts.service.ts` → one write path keeps version, history and events consistent.
- [CONTRACT] S03 → (a) `products.read` / `products.write` as in S03's matrix; (b) `ShopQueryService.getShopsByIds` gives `isSandbox`, `status`, `shopVersion`; (c) `TenancyModule` loaded in core and worker; (d) S03's own `tenancy-backfill.jobs.ts` SQL on `Product` is deleted, the backfill moves here → S03's spec already says so; no change to S03's events needed (sandbox flag is stamped at creation).
- [CONTRACT] S03 offboarding export → S05 provides no product export artifact; `GET /shops/:shopId/products` is blocked by the status gate in `DELETING` (`409 shop_offboarding`), so a product export in the grace window is a gap in S03's export (`shop.export` payload) or a later capability → default: out of scope, noted for the reviewer.
- [CONTRACT] S53 → inbox or version guard for the two consumers; the consumers use their own consumer groups; the producer writes `aggregateId = productId` → IV.5.
- [CONTRACT] S50 → policies `catalog.product-read.ip`, `catalog.product-write.shop`, `catalog.batch-read.ip`; reads fail open, writes fail closed (replaces `search.query` on detail).
- [CONTRACT] S49 → jobs `products.flush-view-counts`, `products.purge-stock-operations`, `products.backfill-shop-ids`.
- [CONTRACT] S48 / W02 → the product page composes `GET /products/:id` (R2) plus `GET /batch/shops` (S03); `shopId` is in the public view for that purpose.
- [CONTRACT] S18 → product-count entitlements, if wanted, are an R1 check S18 exports that `ProductCommandService.create` would call; not enforced now.
- [CONTRACT] S29, S31, S36, S41, S47, S24, S19, S25, S26, S34, S35, S40, S43 → replace their reads and joins on `Product` with `getProductsByIds` (R1, pass `{shopId}` for ownership checks) or the snapshot events (R3); listed per file in `gaps.md`.

## LOCAL

- [LOCAL] Freshness numbers → 60 s fresh, 300 s stale, 10 s negative, ±10% jitter, CDN 15 s + 30 s → kept from SD-34; note 03/04 §9: catalog staleness of minutes is fine.
- [LOCAL] Cache entry size → 32 KiB, bounded by field limits (4,000-character description) → "big keys" without a runtime guard.
- [LOCAL] View flush → 10 s, 1,000 products per statement, counted on `200` and `304` → keeps statements short; revalidations are views.
- [LOCAL] Stock-operation retention → 30 days, purge 5,000 per run → longer than any caller retry window.
- [LOCAL] `applyStockDelta` limits → 100 operations per call, |delta| ≤ 1,000,000, quantity ≤ 1,000,000,000 → fits `INTEGER`, bounds a transaction.
- [LOCAL] OCC conflicts between a seller edit and a checkout decrement → the seller retries on `409`; no per-field merge → simplest correct behaviour.
- [LOCAL] Product create without `Idempotency-Key` → not required by V.6 for products; duplicates are archivable.
- [LOCAL] Product-count entitlement → not enforced (S18's).
- [LOCAL] Shop status copy → one row per shop, version-guarded by `shopVersion`; no row means `ACTIVE` → avoids a read through tenancy on the hot path.
- [LOCAL] Timeouts → cache calls 250 ms, database read 2 s, retries only for the read loader (one layer) → IV.6.
- [LOCAL] Currency → one platform currency, validated, stored per product → expansion needs no contract change.
- [LOCAL] `embedding` and `searchVector` columns → no longer written or serialized by the catalog; S32 decides where they live → D-16.
- [LOCAL] Event `description` in the snapshot → included (≤ 4,000 characters) so projectors need no read.

## Implementation notes (P1 pass, 2026-10-10)

Two scenario wordings that the built framework answers differently; the implementation follows the framework and the contract's answer order, and neither blocks anything.

- AS-02 says a `shopId` in the path that is not a UUID answers `400 validation_failed`. `contracts/http.md` ("Answer order on shop routes") and S03's `ShopScoped` guard answer the hidden-shop `404 shop_not_found` first, for a malformed shop id as for an unknown one (a `400` would tell a prober that the shape was right). Implemented and tested as `404` (`product-write.e2e-spec.ts`, "a shop id that is not a UUID"). A malformed product id is `400` as specified.
- AS-44 lists "whose `type` is unknown" among the envelopes that are dead-lettered. The consumer framework (S53 AS-52) skips an event type the consumer does not handle (counted `ignored`, offset committed, no dead letter) and dead-letters a bad aggregate id, a payload that fails its schema and a newer contract version. Implemented and tested that way (`product-invalidation.e2e-spec.ts`, real broker): three dead letters, the unknown type ignored, no cache change, the rest of the batch applied.
