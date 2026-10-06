# Feature Specification: S32 — Product Search (Index Sync with External Versioning, Zero-Downtime Reindex, Relevance Boosts, Synonyms, Facets, k-NN) (domain `discovery`)

**Feature Branch**: `S32-product-search` (spec directory `specs/domains/S32-product-search`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S32 of `scripts/sdd/capabilities.tsv`. Sources: `docs/showcase/sections/SD-37-product-search-sync.md`, `README.md` (ADR entries on search, fuzzy matching, edge n-grams, k-NN), note `10-System-Design/09-data-and-infrastructure.md` (design 37, product search), `03-Databases/01` §9 (relational full text versus a search engine). Pattern-map rows covered: **P0308** (a relational full-text index for small, tenant-scoped search versus a search engine for catalog-wide search) and **P0408** (CQRS read models: the search index and the shop search table are rebuildable projections). Where the current code and the notes disagree, the notes win.

## Scope

Everything a **buyer** uses to find a product by text, and everything a **seller** uses to find their own products by text, plus the machinery that keeps those answers correct: the search index is a **read model** of the catalog's product events (IX.7 R3). The catalog's table is never read.

In scope:

- **Public product search** (`GET /products/search`): full-text with typo tolerance and field weights, business boosts, filters, sort, cursor paging, facets, semantic (nearest-neighbour) mode, visibility rules, degradation, rate limit.
- **Index sync**: projection of `catalog.product_*` events with external versioning (out-of-order and duplicate events are harmless), archive/restore/delete ordering, sandbox exclusion, shop visibility and plan tier from tenancy events, product image from media events, sponsorship signal, popularity signal, embeddings, poison messages, outages, freshness bound.
- **Zero-downtime reindex**: a run (build a new index beside the live one from the retained event history, dual-write, verify, atomic switch, keep the previous one for rollback), its state machine, cancel, failure, resume after a crash, rollback, retirement, mapping versions, first-time bootstrap, legacy concrete-index migration.
- **Synonyms**: a versioned, validated synonym set that changes search results without a reindex.
- **Shop product search** (`GET /shops/:shopId/products/search`): tenant-scoped text search for sellers on a relational full-text read model owned by this domain.
- **Relevance measurement**: query logging, signed search IDs, click logging, the admin quality report (CTR, MRR, zero-result rate).
- **Platform**: admin index status, the exported in-process search service for other domains, the title-suggestion port for S33, ownership and boundary rules, observability.

Out of scope (owners named):

- Product records, prices, stock, the seller's product *list* (browse without text) → **S05**. Shop lifecycle, plan tier, roles → **S03**. Product photos → **S29** (this capability only consumes the primary image). Video and digital-delivery flags → **S30**, **S31** (not consumed, see `questions.md`).
- Autocomplete, the top-K trie, edge-n-gram completions → **S33** (same domain; this capability only offers the visible-title port). "Bought together" → **S34**. Trending → **S35**. Sponsored-listing campaigns, click tokens and click billing → **S36** (this capability only reads a sponsorship signal and labels sponsored results).
- "Available near me" → **S19** (a separate endpoint family; it neither uses this index nor feeds it). Discussion search and "ask this product" → **S25**, **S47**.
- The search page, filter UI, infinite scroll, URL state → **W02**. The BFF is not involved: search has one owner and one HTTP surface, so no R2 composition applies.
- Rate-limit mechanism → **S50**. Job scheduling → **S49**. Outbox, consumer framework, replay tooling → **S53**. Problem+json filter, metrics registry, config validation → **S54**. Admin authentication → **S01**.
- Language-specific analyzers, spelling-suggestion ("did you mean"), result highlighting, personalised ranking, learning-to-rank, geo ranking. Not built.

## User Scenarios & Testing *(mandatory)*

Notation: `S1`, `S2` are shops (status `ACTIVE` unless stated); `U1` a member of `S1`, `U2` a member of `S2` only, `ADM` a platform administrator, `ANON` an unauthenticated caller; `P1…` products in `S1`; `v3` is a product version; "the engine" is the search engine; "the stream" is the product event stream; "refresh" means waiting until the engine's refresh interval has passed (tests may force it); "the click store" is the analytics store for clicks and queries. A product is **visible** when it is `ACTIVE`, not a sandbox product, not deleted, and its shop is `ACTIVE` (a shop never announced counts as `ACTIVE`). All times are UTC and the clock is frozen in tests.

### User Story 1 — A buyer finds a product by typing words (Priority: P1)

A buyer types "iphnoe case" (with a typo), sees in-stock, well-rated, popular matches first, narrows by price and category, sorts, and pages through the results. They never see archived, sandbox, deleted or suspended-shop products, and an exact title match is never buried by a boost.

**Why this priority**: it is the reason the capability exists; every other story serves it.

**Independent Test**: seed the index with a handful of products and call `GET /products/search`; no other capability is needed.

**Acceptance Scenarios**:

1. **AS-01** (happy path) — **Given** visible products `P1 "iPhone 17 Pro Case"` (brand `Acme`), `P2 "AirPods Pro"`, `P3 "iPhone 17 Screen Protector"` (all `ACTIVE`, in stock), **When** `ANON` calls `GET /products/search?q=iphone`, **Then** `200`, `Cache-Control: private, no-store`, the body parses with `productSearchResponseSchema`: `mode: "lexical"`, `items` holds `P1` and `P3` (not `P2`), each item is `{id, shopId, title, brand, category, priceMinor, currency, rating, inStock, imageUrl: string | null, sponsored: boolean, position}` with `position` 0, 1…; `total: {value: 2, exact: true}`, `nextCursor: null`, `degraded: []`, a non-empty `searchId`, no `facets` key; the item has no embedding, description, score or index field; the engine received exactly one query for this request; and one `search.performed` event `{searchId, query: "iphone", results: 2, mode: "lexical", …}` was emitted.
2. **AS-02** (typo tolerance) — **Given** the products of AS-01, **When** `q=iphnoe` (two letters swapped) and `q=aipods` are searched, **Then** `P1` (resp. `P2`) is returned; **When** `q=xpone`, **Then** `items: []`; **Given** two products `"Case iPhone"` and `"Cose iPhone"` and `q=case`, **Then** the exact match ranks above the fuzzy one; the first character of a term must match exactly (`q=xase` does not find "Case").
3. **AS-03** (field weights) — **Given** `Pa` with the word "espresso" in its title, `Pb` with it only in its brand, `Pc` with it only in its description, `Pd` with it only in its tags, all equal in stock, rating and popularity, **When** `q=espresso`, **Then** the order is `Pa, Pb, Pc, Pd`.
4. **AS-04** (browse mode) — **Given** visible products with different stock, rating, popularity, **When** `GET /products/search` with no `q` (also `q=` and `q=%20%20`), **Then** `mode: "browse"`, all visible products are returned ordered by the business score (descending) then `id` ascending, with no text relevance involved, and no `search.performed` event is emitted for the empty query (queries shorter than two characters are not logged, AS-74).
5. **AS-05** (business boosts) — **Given** two products with identical text and fields except one signal each time, **When** searched with the same `q`, **Then** the in-stock one ranks above the out-of-stock one; the higher-rated above the lower-rated; the more popular above the less popular; the product of a `PRO` shop above one of a `STARTER` shop; the `sponsored: true` product above a non-sponsored one and its item says `sponsored: true`; **Given** each signal missing (new product, no popularity, no tier, no sponsorship), **Then** the product is still searchable and ranks as if neutral (no error, no exclusion).
6. **AS-06** (boosts never bury text relevance) — **Given** `Pa` with the exact title "espresso machine", out of stock, rating 0, popularity 0, and `Pb` that only mentions "machine" in its description, in stock, rating 5, popularity 1,000,000, from a `PRO` shop and sponsored, **When** `q=espresso machine`, **Then** `Pa` is first; the total business multiplier never exceeds 4 (FR-005).
7. **AS-07** (hidden products) — **Given** products matching `q=lamp` that are: archived, a sandbox product, deleted, owned by a `SUSPENDED` shop, by a `DELETING` shop, by a `DELETED` shop, and one visible product, **When** searched (also with `facets=true` and `semantic=true`), **Then** only the visible product appears in `items`, `total`, every facet count and the semantic results; **When** the archived product is restored and the suspended shop reinstated (events processed), **Then** both appear on the next search after refresh.
8. **AS-08** (sort) — **Given** 5 visible products with prices 100, 100, 250, 500, 900 and distinct creation times, **When** `sort=price-asc`, `sort=price-desc`, `sort=newest`, **Then** the orders are by price ascending (ties by `id` ascending), price descending (ties by `id` ascending) and creation time descending (ties by `id` ascending); repeating the call returns the identical order; `sort=relevance` without `q` behaves as browse.
9. **AS-09** (cursor paging) — **Given** 45 visible products matching `q=cable`, **When** `limit=20` is followed through `nextCursor`, **Then** pages hold 20, 20, 5 items with no duplicate and no gap, the last page has `nextCursor: null`, `total` is `{value: 45, exact: true}` on every page; **When** a cursor from `q=cable` is used with `q=charger`, or with a different filter or sort, or is truncated, altered or not base64url, **Then** `422 invalid_cursor` with no engine query; **When** products are indexed between page fetches, **Then** the next page still answers `200` (an item may shift pages but the call never fails).
10. **AS-10** (validation classes) — **When** called with: `limit=0`, `limit=51`, `limit=abc`; `q` of 101 characters; `minRating=6`, `minRating=-1`; `minPriceMinor=-1`, `minPriceMinor=1.5`; `inStock=maybe`; `sort=popular`; `category` or `brand` longer than 100 characters; the removed parameters `size`, `from`, `priceMin`, `priceMax`, `ratingMin`; an unknown parameter; `facets=yes`, **Then** each answers `400 validation_failed` (problem+json with `requestId`, one entry per offending parameter) and no engine query is made; **When** `minPriceMinor=500&maxPriceMinor=100`, **Then** `422 invalid_price_range`.
11. **AS-11** (hostile and unusual text) — **When** `q` is `"iphone" OR price:[0 TO 1]`, `iph*`, `title:iphone AND NOT case`, `\\`, a 100-character string of `(`, an emoji-only string, fullwidth `ＩＰＨＯＮＥ`, or text containing control characters, **Then** every call answers `200`; operators and wildcards are matched as plain words (`iph*` does not match `iPhone`), fullwidth text is normalised and finds `iPhone`, control characters are removed, and the response never contains an engine error.
12. **AS-12** (anonymous, rate limit) — **Given** `ANON` and an authenticated `U1`, **When** both search, **Then** both get `200` with identical visibility (no `401` on this public route); **When** one caller exceeds `discovery.search.query` (120 per minute per user or address), **Then** the next call answers `429` with `Retry-After` and a problem body, and other callers are unaffected; **Given** the limiter store is down, **Then** searches are served (fail open) and a counter increases.
13. **AS-13** (engine failure) — **Given** the engine refuses connections, or answers slower than the 1 s search budget, **When** a search is made, **Then** `503` problem+json `code: "search_unavailable"`, `Retry-After: 1`, `detail` generic, no stack, no engine message, `requestId` present; the `search_unavailable_total` counter increases; no `search.performed` event is emitted; **When** the engine returns, the next search answers `200`.
14. **AS-14** (filters) — **Given** products across categories, brands, prices, ratings, stock, **When** `category=audio&brand=Acme&minPriceMinor=1000&maxPriceMinor=9999&minRating=4&inStock=true` with and without `q`, **Then** only products satisfying all of them appear (a filter is an AND), a filter never changes the relative order of the remaining items (the same two products keep their order when a filter that both satisfy is added), and a filter value that matches nothing answers `200 {items: [], total: {value: 0, exact: true}, nextCursor: null}` with `search.performed` `results: 0`.

### User Story 2 — A buyer narrows results with facets (Priority: P2)

Next to the results the buyer sees counts per category, brand and price band, and keeps seeing the other categories after choosing one, so switching is one click.

**Why this priority**: it turns a long list into a guided choice; it is useless without Story 1.

**Independent Test**: seed products across several categories and brands; call with `facets=true`.

**Acceptance Scenarios**:

1. **AS-15** (facet shape and counts) — **Given** 30 visible products in 3 categories and 4 brands with prices spread across the bands, **When** `q=…&facets=true&limit=5`, **Then** `facets` is `{categories: [{key, count}], brands: [{key, count}], priceRanges: [{key, count}], avgRating: number | null}`; counts cover **all** matches, not the 5 on the page; categories and brands are the top 20 by count descending then `key` ascending; `priceRanges` always has the four keys `under_25` (below 2,500 minor units), `25_to_50` (2,500 to below 5,000), `50_to_100` (5,000 to below 10,000), `over_100` (10,000 and above) in that order; `avgRating` is the mean rating of all matches rounded to two decimals; the price-range counts and the category counts each sum to `total.value` when at most 20 categories exist; products without a brand are not counted in `brands`.
2. **AS-16** (selecting a facet keeps its siblings) — **Given** the data of AS-15, **When** `category=shoes&facets=true`, **Then** `items` and `total` are only shoes, the `brands` and `priceRanges` facets reflect only shoes, but the `categories` facet still lists every category with its count computed without the category filter; likewise a `brand` filter does not collapse the `brands` facet, and a price filter does not collapse `priceRanges`; `inStock` and `minRating` filters apply to every facet.
3. **AS-17** (absence and emptiness) — **When** `facets` is absent or `false`, **Then** the response has no `facets` key; **When** `facets=true` and nothing matches, **Then** `{categories: [], brands: [], priceRanges: [four keys, count 0], avgRating: null}`; more than 20 categories keep only the top 20.

### User Story 3 — A buyer searches by meaning (Priority: P2)

A buyer types "warm jacket for snow" and finds the parka whose title shares no word with the query. If the meaning service is down, they still get lexical results, labelled as degraded.

**Why this priority**: it is an advertised differentiator (nearest-neighbour search), but lexical search must work without it.

**Independent Test**: index products with deterministic test embeddings and call with `semantic=true`.

**Acceptance Scenarios**:

1. **AS-18** (semantic search) — **Given** a test embedding provider that places "winter coat" near "parka" and far from "garden hose", visible products "Alpine Parka" and "Garden Hose 20 m", **When** `q=winter coat&semantic=true`, **Then** `mode: "semantic"`, the parka ranks first; `nextCursor` is `null`; at most `limit` items; **Given** 60 products of which 10 match `category=outerwear`, **When** `semantic=true&category=outerwear&limit=10`, **Then** all 10 outerwear products are returned (filters apply before neighbours are chosen, so a filter never starves the result).
2. **AS-19** (semantic rules) — **When** `semantic=true` without `q`, **Then** `422 semantic_requires_query`; **When** `semantic=true` with `facets=true` or with `cursor`, **Then** `422 unsupported_combination`; **Given** a visible product whose vector is missing (embedding pending), **Then** it is absent from semantic results and present in lexical ones; hidden products never appear (AS-07).
3. **AS-20** (provider failure) — **Given** the embedding provider times out (budget 300 ms) or fails, **When** `q=winter coat&semantic=true`, **Then** `200` with lexical results for `q`, `mode: "lexical"`, `degraded: ["semantic_unavailable"]`, counter `search_degraded_total{reason="semantic_unavailable"}` +1, and the `search.performed` event carries `degraded: ["semantic_unavailable"]`; no `5xx`.
4. **AS-21** (embeddings at indexing) — **Given** a `catalog.product_created`, **When** it is projected, **Then** the document has a vector computed from title, description, brand, category and tags and the vector is never serialised in any response; **When** a `catalog.product_updated` has `changedFields` of only `["priceMinor","quantity"]`, **Then** the provider is not called and the vector is unchanged; **When** `changedFields` contains `title`, **Then** it is recomputed; **Given** the provider fails during projection, **Then** the product is indexed without a vector, `embedding_pending` is true, lexical search finds it, and the `search.backfill-embeddings` job later fills it (single run, batch limited, idempotent), after which semantic search finds it.

### User Story 4 — The index follows the catalog, whatever order events arrive in (Priority: P1)

A seller edits a product three times in a second; events are redelivered, reordered, or replayed. The index ends up showing the newest version, never an older one, and products that must disappear do.

**Why this priority**: wrong results are worse than slow results; this is the "external versioning" pattern (P0408) and the data foundation of Stories 1, 2, 3, 5, 7.

**Independent Test**: deliver real event envelopes to the consumer and read the index.

**Acceptance Scenarios**:

1. **AS-22** (created becomes searchable) — **Given** an empty index, **When** `catalog.product_created` `{productId: P1, productVersion: 1, …, status: "ACTIVE", isSandbox: false}` is delivered, **Then** after refresh `P1` is found by its title; the stored document has `productVersion 1`, `popularity 0`, `imageUrl null`, no sponsorship; the consumer checkpoint advanced.
2. **AS-23** (out-of-order delivery) — **Given** `P1` indexed at `v1`, **When** `v3` (title "Gamma") then `v2` (title "Beta") are delivered, **Then** the index keeps `v3` ("Gamma"), the `v2` is acknowledged and counted in `search_stale_events_ignored_total`, no error, no DLQ entry; **When** `v2` then `v3`, **Then** the final state is the same.
3. **AS-24** (duplicates) — **When** the same event (same `eventId`) is delivered twice, and when a second envelope with another `eventId` but the same `productVersion` and payload is delivered, **Then** the index holds one document with unchanged content, the document count is unchanged, and the effect is a single logical write.
4. **AS-25** (archive and restore ordering) — **Given** `P1` active at `v3`, **When** `catalog.product_archived` `v4` is delivered, **Then** `P1` is no longer returned by public search; **When** a late `catalog.product_updated` `v3` arrives, **Then** `P1` stays hidden; **When** `catalog.product_restored` `v5` arrives, **Then** `P1` is returned again; **When** `restored v5` arrives **before** `archived v4`, **Then** the final state is `ACTIVE` at `v5` and `archived v4` is ignored.
5. **AS-26** (delete is remembered) — **Given** `P1` at `v3`, **When** `catalog.product_deleted` `{productVersion: 6}` is delivered, **Then** `P1` disappears from public search and from the shop search table; **When** a late `created v1`, `updated v5` or `updated v6` arrives afterwards, **Then** `P1` does not reappear; **When** the 30-day tombstone purge job runs with the clock at +30 days + 1 s, **Then** the remembered delete is removed (an event at that point would be a new product); before that the purge removes nothing.
6. **AS-27** (sandbox) — **When** an event with `isSandbox: true` is delivered, **Then** it is acknowledged, counted in `search_ignored_total{reason="sandbox"}`, no public index document exists for it, and no error is raised; the product is searchable in its own shop's search (AS-67).
7. **AS-28** (shop status) — **Given** visible products of `S1`, **When** `tenancy.shop_status_changed {shopId: S1, from: "ACTIVE", to: "SUSPENDED", shopVersion: 7}` is delivered, **Then** after refresh none of `S1`'s products appear in public search, including products created for `S1` afterwards; **When** `{to: "ACTIVE", shopVersion: 8}` is delivered, **Then** they reappear; **When** a late `{to: "SUSPENDED", shopVersion: 6}` arrives, **Then** it is ignored; **When** a product event arrives for a shop whose status was never announced, **Then** it is treated as `ACTIVE`; **When** the product event arrives before or after the shop event, **Then** the final visibility is the same.
8. **AS-29** (offboarding and deletion) — **When** `tenancy.shop_offboarding_started {shopId, purgeAt}` is delivered, **Then** the shop's products are hidden from public search; **When** `tenancy.shop_offboarding_cancelled {shopId}` is delivered after it, **Then** they are visible again; with the two reordered by `occurredAt`, the later one wins; **When** `tenancy.shop_deleted {shopId}` is delivered, **Then** every public document and every shop search row of the shop is removed, later product events for that shop are acknowledged and ignored (`search_ignored_total{reason="shop_deleted"}`), and a repeated `shop_deleted` changes nothing.
9. **AS-30** (plan tier) — **When** `tenancy.shop_plan_changed {shopId, plan: "PRO", shopVersion: 4}` is delivered, **Then** that shop's products carry the `PRO` tier boost (AS-05); an older `shopVersion` is ignored; an unknown `plan` value is dead-lettered with no change.
10. **AS-31** (sponsorship) — **When** `marketing.product_sponsorship_changed {productId, shopId, sponsored: true, sponsorshipVersion: 2}` is delivered, **Then** the item says `sponsored: true` and is boosted; a late `{sponsored: false, sponsorshipVersion: 1}` is ignored; the signal never makes a hidden product visible and arriving before the product event is kept and applied when the product appears.
11. **AS-32** (image) — **When** `media.gallery_changed {productId, shopId, mediaIds: [m1, m2], galleryVersion: 2}` is delivered, **Then** the item's `imageUrl` is the thumbnail URL of `m1`; `mediaIds: []` sets `null`; an older `galleryVersion` is ignored; **When** the image event arrives before the product's first event, **Then** the product shows the image once created; **When** a product update follows an image event, **Then** the image is still there; **When** an image event follows a product update, **Then** the product's fields are unchanged.
12. **AS-33** (invalid and unknown messages) — **When** a `catalog.product_updated` with a missing `productVersion`, a negative `priceMinor`, an invalid currency, a non-UUID `productId`, or `version: 2` of the envelope arrives, **Then** it is dead-lettered with its reason, nothing changes in the index or the shop search table, and the next valid message in the same partition is processed; **When** a message of an unknown `type` arrives, **Then** it is acknowledged and counted in `search_ignored_total{reason="unknown_type"}`.
13. **AS-34** (coalescing) — **Given** 30 `catalog.product_updated` events for `P1` (`v2…v31`) in one delivered batch, **When** processed, **Then** the engine receives one write for `P1` carrying `v31`, and the final document is `v31`.
14. **AS-35** (engine outage during projection) — **Given** the engine is unavailable, **When** a batch is delivered, **Then** it is not acknowledged and is retried with exponential backoff and jitter; **When** the engine recovers, **Then** the documents are indexed and no event is lost; a permanent per-document rejection by the engine (a mapping error) is dead-lettered after the retry limit and the rest of the batch is applied.
15. **AS-36** (freshness) — **When** a `catalog.product_updated` that changes price and stock is published to the stream, **Then** public search shows the new price and stock within 10 seconds (p95) and the shop search table within 5 seconds (p95) of the event's `occurredAt`; the metric `search_projection_lag_seconds` reports the measured delay.
16. **AS-37** (popularity) — **Given** the click store holds 120 clicks on `P1` and 2 on `P2` within the last 30 days (none older), **When** the `search.refresh-popularity` job runs, **Then** `P1`'s popularity bucket is higher than `P2`'s (AS-86), only documents whose bucket changed are written, no product field or `productVersion` changes, a product update arriving afterwards keeps the popularity, and two concurrent runs execute once.
17. **AS-38** (shop state backfill) — **Given** products indexed for shops whose status was never announced, **When** `search.backfill-shop-state` runs, **Then** it asks tenancy for up to 500 shop IDs per call (R1 `ShopQueryService.getShopsByIds`), stores `{status, shopVersion}` with the version guard, a `SUSPENDED` shop's products become hidden, an unknown shop stays `ACTIVE`, the job is resumable and a rerun changes nothing.

### User Story 5 — An administrator rebuilds the index without taking search down (Priority: P1)

A mapping change or a new embedding model needs every document rewritten. An administrator starts a reindex; buyers keep searching without a single error or empty page; the new index replaces the old one in one atomic step; a bad result can be rolled back in seconds.

**Why this priority**: it is the "alias swap" pattern and the only safe way to change the index shape in production.

**Independent Test**: seed events in the stream, call the admin endpoints, poll search while the run executes.

**Acceptance Scenarios**:

1. **AS-39** (happy path) — **Given** an index serving 1,000 visible products and the full history in the stream, **When** `ADM` calls `POST /admin/search/reindex`, **Then** `202 {runId, kind: "REINDEX", status: "QUEUED"}`; the run moves `QUEUED → BUILDING → CATCHING_UP → COMPLETED`, each transition recorded with its time; afterwards the live name points to the new index, which holds the same documents (count and `productVersion` per product) as before, `mappingVersion` equals the current one, the previous index still exists, `GET /admin/search/reindex/{runId}` answers `{runId, kind, status: "COMPLETED", documents, startedAt, finishedAt, mappingVersion, index, previousIndex, failureReason: null}`, a history row exists, and `search.reindex_completed` was emitted.
2. **AS-40** (zero downtime) — **Given** a client searching 50 times per second throughout, **When** a run executes, **Then** every search answers `200`, the `total` of a fixed query never drops below its starting value, no response is empty, and the switch is a single atomic step (there is no instant at which the live name points to nothing or to two indices).
3. **AS-41** (changes during the build) — **Given** a run in `BUILDING`, **When** products are created, updated (`v2 → v3`), archived and deleted, and a shop is suspended, **Then** after `COMPLETED` the new index reflects all of them exactly as the old one does, and an older version never replaces a newer one.
4. **AS-42** (one active run) — **Given** a run in `QUEUED`, `BUILDING` or `CATCHING_UP`, **When** `POST /admin/search/reindex` or `POST /admin/search/rollback` is called, **Then** `409 reindex_in_progress` with the active `runId`; **When** two `POST /admin/search/reindex` race (`Promise.all`) with no active run, **Then** exactly one answers `202` and one `409`, and exactly one active run row exists; once a run is `COMPLETED`, `FAILED` or `CANCELLED`, a new one is accepted.
5. **AS-43** (cancel and illegal transitions) — **When** `POST /admin/search/reindex/{runId}/cancel` is called on a run in `QUEUED`, `BUILDING` or `CATCHING_UP`, **Then** `200 {status: "CANCELLED"}`, the half-built index is deleted, the live name is unchanged, dual-writing stops, and the history records the cancel; **When** it is called on a `COMPLETED`, `FAILED` or `CANCELLED` run, **Then** `409 invalid_transition` and nothing changes; an unknown `runId` answers `404 run_not_found`; a malformed one `400`; **When** cancel races the final switch (`Promise.all`), **Then** exactly one wins and the final state is consistent (either `CANCELLED` with the old index live, or `COMPLETED` with the new index live, never a mix).
6. **AS-44** (failure leaves search untouched) — **Given** a run whose built index ends with fewer documents than the history requires (a document batch was rejected, or the verification gate sees a count mismatch), **When** the gate runs, **Then** the run becomes `FAILED` with `failureReason: "verification_failed"`, the live name is unchanged, the half-built index is deleted, dual-writing stops, the failure is counted in `search_reindex_failed_total`, and a new run is accepted; the same happens for an engine failure during the build (`failureReason: "engine_unavailable"`).
7. **AS-45** (crash and resume) — **Given** a run in `BUILDING` whose worker stops (lease expiry) after half the history, **When** another worker claims the job, **Then** the run resumes from its saved position, the final index has every product exactly once, and no document is rewritten with an older version; **Given** a worker that stops after the switch but before recording `COMPLETED`, **When** the job is re-claimed, **Then** the run is recorded `COMPLETED` without a second switch.
8. **AS-46** (rollback) — **Given** a `COMPLETED` run with the previous index retained, **When** `POST /admin/search/rollback`, **Then** `202 {runId, kind: "ROLLBACK", status: "QUEUED"}` and the live name atomically points back to the previous index, which already contains every update applied since the switch (it was written to in parallel); the replaced index becomes the retained one (a second rollback rolls forward); **Given** no retained index, **Then** `409 no_previous_index`.
9. **AS-47** (retention) — **Given** a retained previous index, **When** the `search.retire-previous-index` job runs with the clock before 24 hours after the switch, **Then** nothing is deleted; **When** after 24 hours, **Then** the previous index is deleted, parallel writes to it stop, and rollback answers `409 no_previous_index`; the job never deletes the index the live name points to nor the target of an active run.
10. **AS-48** (legacy concrete index) — **Given** an environment whose live name is a concrete index (not a pointer), **When** a run completes, **Then** the switch replaces the concrete index by the pointer to the new index in one atomic step, searches never fail, and afterwards the live name is a pointer.
11. **AS-49** (mapping and model versions) — **Given** the application expects mapping version 3 while the live index was built with 2, **When** `GET /admin/search/index`, **Then** `outdated: true` with both numbers; the application never alters an existing index on startup; **When** a run completes, **Then** `outdated: false`; **Given** the embedding model version changed, **When** a run completes, **Then** every vector was recomputed with the new model (and carried over unchanged when the version is the same), and semantic search works afterwards.
12. **AS-50** (first start) — **Given** an environment with neither a live name nor any index, **When** the application starts (two instances at once), **Then** exactly one empty versioned index exists behind the live name, searches answer `200` with `items: []`, the status shows `documentCount: 0`, and a first run fills it from the history; **Given** a live name exists, **Then** startup changes nothing.
13. **AS-51** (shop search table is rebuilt too) — **Given** the shop search table is empty or missing rows, **When** a run completes, **Then** every non-deleted product of the history has its row (same version guard), rows of deleted products are absent, and the table never held a value older than the history's latest version.
14. **AS-52** (who may run it) — **When** any reindex, rollback, cancel, status, synonyms, index-status or quality endpoint is called without credentials, **Then** `401`; by a shop `OWNER`, an ordinary user or a service principal without the administrator role, **Then** `403`; an `ADM` call is recorded in the audit log with the actor ID, the action and the run ID (no secret, no query text); **When** one administrator exceeds `discovery.search-admin` (30 per minute), **Then** `429` with `Retry-After`, and the limiter store being down answers `503` (fail closed).

### User Story 6 — An administrator teaches search a new word without a rebuild (Priority: P2)

Customers search "earbuds" and the catalog says "AirPods". An administrator adds a synonym rule; it works within seconds, for every product, with no reindex.

**Why this priority**: it is cheap relevance tuning with large payoff; it needs Story 1.

**Independent Test**: index "AirPods Pro", search "earbuds" before and after a rule change.

**Acceptance Scenarios**:

1. **AS-53** (live update) — **Given** a visible "AirPods Pro" and no rule for it, **When** `q=earbuds`, **Then** it is not found; **When** `ADM` calls `PUT /admin/search/synonyms {rules: ["airpods, earbuds"], expectedVersion: 1}`, **Then** `200 {version: 2, ruleCount: 1, updatedAt, unchanged: false}` and the next search for `earbuds` (within 5 seconds) finds it; the live index name is unchanged, no reindex run exists, no document was rewritten.
2. **AS-54** (rule kinds) — **Given** the rules `["tv => television", "sneakers, trainers", "usb c, usb-c, type c"]`, **Then** `q=tv` finds "Television 55 inch", `q=television` does not find a product titled "TV Stand 55 inch" **by that rule** (one-way), `q=trainers` finds "Sneakers Pro" and `q=sneakers` finds "Trainers Pro" (two-way), `q=usb c` finds "USB-C cable" (multi-word).
3. **AS-55** (validation) — **When** `PUT` carries more than 5,000 rules, a rule longer than 200 characters, an empty rule, a comma rule with fewer than two terms, a `=>` rule with an empty side, disallowed characters, duplicate rules, or two one-way rules forming a cycle (`a => b`, `b => a`), **Then** `422 invalid_synonym_rules` with `errors: [{index, code}]` (codes `too_many`, `too_long`, `empty`, `too_few_terms`, `empty_side`, `invalid_character`, `duplicate`, `cycle`), the active rules and `version` are unchanged; a body that is not `{rules: string[], expectedVersion: integer}` answers `400 validation_failed`.
4. **AS-56** (concurrent edits) — **Given** version 2, **When** two administrators `PUT` different rules with `expectedVersion: 2` at once (`Promise.all`), **Then** exactly one answers `200` (version 3) and the other `409 synonyms_version_conflict {currentVersion: 3}`; the active rules are the winner's; a stale `expectedVersion` always answers `409`.
5. **AS-57** (idempotent replay) — **When** the same `PUT` (same rules, same `expectedVersion`) is sent twice, or sent with a stale `expectedVersion` but rules identical to the current ones, **Then** both answer `200` with `unchanged: true` on the repeat, `version` does not advance and no engine call is made.
6. **AS-58** (engine failure) — **Given** the engine is unavailable or rejects the rules, **When** `PUT` is called, **Then** `503 search_unavailable`, `GET /admin/search/synonyms` still returns the previous rules and version, and search keeps using the previous rules; a later `PUT` succeeds.
7. **AS-59** (rules survive a reindex) — **Given** rules at version 4, **When** a run completes, **Then** the new index answers `earbuds` exactly as before, with no manual step.
8. **AS-60** (read and audit) — **When** `ADM` calls `GET /admin/search/synonyms`, **Then** `200 {version, rules, updatedAt, updatedBy}`; every successful `PUT` writes an audit log line `{actorId, version, ruleCount}` and keeps the previous version's rules retrievable for 90 days (the last 20 versions); authentication and role rules as AS-52.

### User Story 7 — A seller finds their own products by text (Priority: P2)

A seller types "iphnoe cse" in the dashboard and finds "iPhone 17 Pro Case" in their own shop, including archived items, never anyone else's product.

**Why this priority**: it is the small, tenant-scoped use of a relational full-text index (P0308); it needs the same event feed as Story 4.

**Independent Test**: seed the shop search table through events and call the route as members of different shops.

**Acceptance Scenarios**:

1. **AS-61** (happy path) — **Given** `U1` is a member of `S1` which has "iPhone 17 Pro Case" (active), "iPhone 16 Case" (archived), "USB Cable", **When** `GET /shops/S1/products/search?q=iphone case`, **Then** `200`, parses with `shopProductSearchResponseSchema`: `{items: [{id, title, priceMinor, currency, quantity, status, rank}], nextCursor}`; both iPhone products are listed (best rank first), the archived one with `status: "ARCHIVED"`, the cable absent; **When** `status=ACTIVE` is added, **Then** only the active one.
2. **AS-62** (typos) — **When** `q=iphnoe cse`, **Then** "iPhone 17 Pro Case" is found by the trigram fallback; **When** `q=zz`, **Then** `items: []`; a query of up to 8 words is used, extra words are ignored for the fallback only.
3. **AS-63** (cross-tenant) — **Given** `S1` and `S2` both have "iPhone 17 Pro Case", **When** `U2` calls the route for `S1`, **Then** `404` with a body identical to the unknown-shop `404` (S03 guard); **When** `U1` searches `S1`, **Then** only `S1`'s product appears; no row of `S2` ever appears in any response, and the tenant predicate is part of the query itself.
4. **AS-64** (authentication and status gate) — **When** called without credentials, **Then** `401`; **Given** a `VIEWER` member, **Then** `200` (read permission); **Given** `S1` is `SUSPENDED`, **Then** `403 shop_suspended`; `DELETING`: `409 shop_offboarding`; `DELETED`: `404` (the S03 gate).
5. **AS-65** (validation) — **When** `q` is missing, empty, whitespace-only or longer than 100 characters, `limit` is `0` or above 50, `status` is not `ACTIVE` or `ARCHIVED`, the `shopId` is not a UUID, **Then** `400 validation_failed` (an empty `q` is not a listing: the seller's product list is S05's); **When** a cursor is altered or comes from another shop or query, **Then** `422 invalid_cursor`.
6. **AS-66** (paging) — **Given** 60 products of `S1` matching `q=cable`, **When** `limit=25` is followed through `nextCursor`, **Then** pages hold 25, 25, 10 with no duplicate or gap, equal ranks are ordered by `id` ascending, and the last `nextCursor` is `null`.
7. **AS-67** (lifecycle and freshness) — **Given** the events of Story 4, **When** a product is created, renamed, archived, restored, deleted, **Then** shop search reflects each within 5 seconds (p95) (archived stays listed with its status, deleted disappears); a sandbox shop's products are searchable inside that sandbox shop and never in public search; **When** `tenancy.shop_deleted` is processed, **Then** every row of the shop is gone and the route answers `404`.
8. **AS-68** (hostile input) — **When** `q` is `'; DROP TABLE x; --`, `a & b | !c`, `"quoted`, `\\`, `{a,b}`, a string of 8 words each containing quotes or backslashes, **Then** `200`, no engine or database error, the text is matched literally, and the table still exists.
9. **AS-69** (rate limit) — **When** one member exceeds `discovery.shop-search` (120 per minute per user and shop), **Then** `429` with `Retry-After`; another member or shop is unaffected; limiter store down → served.

### User Story 8 — The team measures whether search is any good (Priority: P3)

Every search is logged without personal data, clicks on results are recorded, and an administrator reads click-through rate, mean reciprocal rank and zero-result rate per query before and after changing a boost or a synonym.

**Why this priority**: tuning without measurement is guessing; it is the evaluation loop of the notes.

**Independent Test**: perform searches, post clicks, read the report.

**Acceptance Scenarios**:

1. **AS-70** (click recorded) — **Given** a response with `searchId` for `q=iphone`, **When** `POST /search/clicks {searchId, productId: P1, position: 0}` (anonymous or authenticated), **Then** `202` with an empty body, and `search.result_clicked {searchId, query: "iphone", productId: P1, position: 0}` is emitted; after projection one row exists in the click store.
2. **AS-71** (click validation and forgery) — **When** `searchId` is forged, altered, expired (clock +24 h + 1 s) or missing, **Then** `422 invalid_search_id` and nothing is emitted; `position` of `-1`, `100`, `1.5`, or a non-UUID `productId`, or unknown fields, **Then** `400 validation_failed`; **When** the click limit `discovery.search-click` (300 per minute per address) is exceeded, **Then** `429` with `Retry-After`.
3. **AS-72** (click consumer) — **When** the same `search.result_clicked` envelope is delivered twice, **Then** exactly one row exists; **When** an invalid payload (negative position, missing `searchId`) is delivered, **Then** it is dead-lettered with no row.
4. **AS-73** (quality report) — **Given** 10 searches for `q=iphone` (2 with zero results) and 4 clicks at positions 0, 0, 1, 4 within the last 7 days, and old rows beyond the window, **When** `ADM` calls `GET /admin/search/quality?days=7&limit=50`, **Then** the row for `iphone` is `{query, searches: 10, ctr: 0.4, mrr: 0.27, zeroResultRate: 0.2}` (mrr = (1 + 1 + 1/2 + 1/5) / 10 = 0.27, rounded to three decimals), ordered by `searches` descending; **When** `days` is `0`, `91`, `abc`, or `limit` is `0` or above 100, **Then** `400 validation_failed` (no silent clamping); authentication rules as AS-52.
5. **AS-74** (privacy of the log) — **When** a search is performed with `q` containing an email address, a run of nine or more digits, or a card-like number, **Then** the emitted and stored query is `[redacted]` and `results` is still recorded; queries shorter than two characters are not logged; the `userHash` is stable for one caller and different for different callers, is derived with a dedicated secret (never the session secret), and no user ID, address, token or header appears in the event; stored query rows expire after 90 days.
6. **AS-75** (logging never hurts search) — **Given** the event stream is unavailable, **When** a search or a click is made, **Then** the search answers `200` at normal latency (the click answers `202`), `search_events_dropped_total` increases, and nothing is thrown to the caller.
7. **AS-76** (event contents) — **When** searches run in each mode and with each filter, **Then** `search.performed` is `{eventId, type, version: 1, occurredAt, aggregateId: searchId, payload: {searchId, query, results, mode, userHash, filters: string[] (names only, never values), degraded: string[], surface: "http" | "internal"}}` and parses with `searchEventSchemas`.

### User Story 9 — Platform and neighbouring capabilities rely on search without touching its data (Priority: P3)

The assistant searches products through a service call, autocomplete asks for visible titles, operators read index health, and no other domain's tables are queried by search.

**Why this priority**: it is what keeps the domain boundaries (IX, X) true.

**Independent Test**: a test module that imports only the domain's public entry point; static gates.

**Acceptance Scenarios**:

1. **AS-77** (index status) — **When** `ADM` calls `GET /admin/search/index`, **Then** `200 {alias, activeIndex, previousIndex: string | null, previousRetiresAt: string | null, mappingVersion, expectedMappingVersion, outdated, embeddingModelVersion, documentCount, embeddingPendingCount, synonymsVersion, projectionLagSeconds, activeRun: {runId, status} | null, lastRun: {runId, kind, status, finishedAt} | null}`; authentication rules as AS-52.
2. **AS-78** (exported search service, R1) — **Given** a test module that imports only `@app/domains/discovery`, **When** `ProductSearchService.search({q, filters, sort, limit ≤ 20, surface: "internal"})` is called, **Then** it returns the same `ProductSearchResponse` as the route, applies the same visibility rules (AS-07), never serialises vectors, emits `search.performed` with `surface: "internal"`, refuses `limit` above 20 with a validation error, and accepts no cursor.
3. **AS-79** (title suggestions port) — **When** `ProductTitleSuggester.suggestTitles(prefix, size ≤ 10, signal?)` is called, **Then** it returns at most `size` titles of visible products only (never archived, sandbox, deleted, or suspended-shop products), honours the abort signal, and fails with a typed timeout error rather than hanging.
4. **AS-80** (boundaries) — **Given** the repository after this capability, **Then** `pnpm check:table-ownership --strict` reports zero findings for `discovery`'s search code, `pnpm check:boundaries` is green, no file under the search code imports a catalog, tenancy or orders model or `@app/domains/<d>/infra`, no search code issues SQL on a table the domain does not own, the generic search-engine client under `libs/infrastructure` contains no product mapping, query or domain name, `catalog` imports nothing from `discovery`, and the module barrel exports no projector, consumer, logger or model.
5. **AS-81** (version guard decision, pure) — **Given** the pure decision function over `(stored: {version, deleted} | none, incoming: {version, kind})`, **Then**, table-driven: no stored → apply; incoming > stored → apply; incoming = stored → apply as a harmless re-write; incoming < stored → ignore as stale; stored deleted at `v6`: incoming `≤ 6` of any kind → ignore, `> 6` of kind created → apply (a new product), `> 6` of other kinds → ignore; each signal (shop state, image, sponsorship, popularity) uses its own version and never compares against another source's version; every `switch` over event kinds ends in an exhaustive check.
6. **AS-82** (run state machine, pure) — **Given** the run statuses, **Then** exactly these transitions are legal and every other pair is `invalid_transition`: `QUEUED → BUILDING`, `QUEUED → CANCELLED`, `BUILDING → CATCHING_UP`, `BUILDING → FAILED`, `BUILDING → CANCELLED`, `CATCHING_UP → COMPLETED`, `CATCHING_UP → FAILED`, `CATCHING_UP → CANCELLED`; `COMPLETED`, `FAILED`, `CANCELLED` are terminal (table-driven over all pairs, exhaustive check).
7. **AS-83** (synonym grammar, pure) — **Given** the rule parser, **Then**, table-driven, each valid and invalid rule of AS-55 and AS-54 yields the expected normalised rule or error code; normalisation lower-cases, trims, collapses spaces, sorts the terms of a two-way rule and detects duplicates and cycles.
8. **AS-84** (cursor codec, pure) — **Given** the cursor codec, **Then** a cursor encodes the last item's sort values and `id` plus a fingerprint of `(q, filters, sort, mode)`; decoding with another fingerprint, altered bytes, a wrong length or a wrong type fails with `invalid_cursor`; the encoding is opaque (base64url, no readable field names) and round-trips for every sort mode.
9. **AS-85** (query normalisation and redaction, pure) — **Given** the normaliser, **Then**, table-driven: Unicode compatibility folding, whitespace collapse, control-character removal, trimming, a 100-character cap check, case preserved for the engine and lower-cased for the log; the redactor replaces emails, nine-or-more digit runs and card-like numbers with `[redacted]`.
10. **AS-86** (popularity bucket, pure) — **Given** the bucket function from a 30-day click count, **Then**, property-based and table-driven: it is monotone non-decreasing, bounded (maximum bucket 10), `0` for zero clicks, logarithmic (a tenfold increase raises the bucket by at most 2), and the combined business multiplier of AS-06 stays within `[1, 4]` for every combination of in-stock, rating 0–5, bucket 0–10, tier and sponsorship.

### Edge Cases

Each is an acceptance scenario above; the list shows where.

- **Out-of-order and duplicate events**: stale and reordered product events AS-23, duplicates AS-24, archive/restore order AS-25, delete then late event AS-26, reordered shop events AS-28/AS-29, reordered image and sponsorship AS-31/AS-32, decision table AS-81, burst of 30 updates AS-34, duplicate click events AS-72.
- **Illegal state transitions**: reindex runs AS-42/AS-43/AS-82, rollback with no previous index AS-46/AS-47.
- **Concurrency**: two reindex triggers AS-42, cancel racing the switch AS-43, two synonym edits AS-56, two instances bootstrapping AS-50, two popularity runs AS-37.
- **Idempotent replay**: events AS-24, synonyms `PUT` AS-57, backfill and jobs AS-37/AS-38/AS-47, shop-deleted twice AS-29.
- **Cross-tenant access**: shop search AS-63; public search never leaks shop-hidden products AS-07; admin routes AS-52.
- **Limits**: `q` length, `limit`, rule count and length, facet size, cursor tampering, rate limits AS-10, AS-12, AS-55, AS-65, AS-69, AS-71.
- **Timeouts and degradation**: engine down or slow AS-13, embedding provider AS-20, projection outage AS-35, event-stream outage AS-75, worker crash AS-45, limiter store down AS-12.
- **Poison input**: invalid and unknown messages AS-33, invalid click events AS-72.
- **Privacy**: AS-74.

## Requirements *(mandatory)*

### Functional Requirements

**Public search**

- **FR-001**: `GET /products/search` is public (anonymous allowed) and accepts only `q`, `category`, `brand`, `minPriceMinor`, `maxPriceMinor`, `minRating`, `inStock`, `sort`, `facets`, `semantic`, `limit`, `cursor`; any other parameter or an invalid value answers `400 validation_failed`; a price range with min above max answers `422 invalid_price_range` (AS-10).
- **FR-002**: `q` is trimmed, Unicode-compatibility-normalised, stripped of control characters, whitespace-collapsed, at most 100 characters; operators, quotes, wildcards and field syntax are plain text; an empty `q` selects browse mode (AS-04, AS-11).
- **FR-003**: Lexical matching tolerates typos (edit distance grows with term length, the first character must match), weights title above brand above description above tags, and ranks exact matches above fuzzy ones (AS-02, AS-03).
- **FR-004**: Only visible products (active, not sandbox, not deleted, shop active) can appear in items, totals, facets, semantic results and title suggestions; a shop never announced is active (AS-07, AS-28, AS-79).
- **FR-005**: Business boosts are in stock, rating, popularity (damped), the shop's plan tier and the sponsored flag; each missing signal is neutral; the combined multiplier is within `[1, 4]` so text relevance always dominates (AS-05, AS-06, AS-86).
- **FR-006**: Filters (`category`, `brand` exact and case-sensitive, price range in minor units, `minRating`, `inStock`) are unscored and combined with AND; they never change the relative order of the remaining items (AS-14).
- **FR-007**: Sorts are `relevance` (default with `q`), `price-asc`, `price-desc`, `newest`; without `q` the default is browse order; every order is total, ending in `id` ascending (AS-04, AS-08).
- **FR-008**: Paging is by an opaque cursor bound to `(q, filters, sort, mode)`; `limit` is 1–50, default 20; offset paging does not exist; `total` is `{value, exact}` with `exact: false` when more than 10,000 products match; a bad cursor answers `422 invalid_cursor` (AS-09, AS-84).
- **FR-009**: Responses use explicit DTOs validated by `productSearchResponseSchema` in `packages/contracts`; they never expose index documents, embeddings, scores or internal fields; every response carries `searchId`, `mode`, `degraded`, and `Cache-Control: private, no-store` (AS-01).
- **FR-010**: With `facets=true` the response carries category and brand facets (top 20), four fixed price bands and the average rating, counted over all matches, each facet ignoring its own filter (AS-15, AS-16, AS-17).
- **FR-011**: When the engine is unreachable or exceeds the 1 s budget, the answer is `503 search_unavailable` with `Retry-After: 1` and a generic detail (AS-13).
- **FR-012**: Search is rate limited by policy `discovery.search.query` (120 per minute per user or address, fail open); excess answers `429` with `Retry-After` (AS-12).
- **FR-013**: One search issues exactly one engine query; no suggestion query rides along (AS-01).

**Semantic (k-NN)**

- **FR-014**: `semantic=true` requires `q`, returns the `limit` (≤ 50) nearest visible products that have a vector, applies filters before choosing neighbours, and rejects `facets` and `cursor` with `422 unsupported_combination` (AS-18, AS-19).
- **FR-015**: The query vector comes from a replaceable embedding provider with a 300 ms budget; on failure the search answers lexically with `mode: "lexical"` and `degraded: ["semantic_unavailable"]` (AS-20).
- **FR-016**: Vectors are computed by this capability at projection from title, description, brand, category and tags, only when one of those changed; a failure indexes the product without a vector and a backfill job completes it; vectors never leave the service; a model-version change takes effect through a reindex (AS-21, AS-49).

**Index sync (read model, IX.7 R3)**

- **FR-017**: The public index and the shop search table are projections of `catalog.product_*` events (full snapshots); the catalog's table is never read and no catalog model is injected (AS-22, AS-80).
- **FR-018**: Product fields carry the product's `productVersion`; an incoming event is applied when its version is at least the stored one and ignored (and counted) when lower; re-applying an equal version leaves identical content (AS-23, AS-24, AS-81).
- **FR-019**: Every other source has its own guard: shop state (`shopVersion`, or the envelope time for events without a version), image (`galleryVersion`), sponsorship (`sponsorshipVersion`), popularity (computation time); any arrival order converges to the same document and a source never overwrites another source's fields (AS-28, AS-29, AS-31, AS-32, AS-81).
- **FR-020**: Archive hides, restore shows, delete removes and is remembered for 30 days so older events cannot resurrect the product; a created event above the remembered version is a new product (AS-25, AS-26).
- **FR-021**: Sandbox products never enter the public index; they enter the shop search table of their own sandbox shop (AS-27, AS-67).
- **FR-022**: Shop status, offboarding, deletion and plan tier come from tenancy events; hidden shops hide all products, including later ones; deletion purges every public document and shop row of the shop (AS-28, AS-29, AS-30).
- **FR-023**: The product image is the thumbnail of the first media ID of `media.gallery_changed`, resolved at projection time so search never calls the media domain at query time (AS-32).
- **FR-024**: The sponsorship flag boosts and labels an item, never overrides visibility, and is kept if it arrives before the product (AS-31).
- **FR-025**: Consumers validate payloads, dead-letter invalid or unsupported-version messages with no side effect, acknowledge unknown types, coalesce per product within a batch, retry engine outages with exponential backoff and jitter without acknowledging, and dead-letter permanent per-document rejections after the retry limit (AS-33, AS-34, AS-35).
- **FR-026**: A change is searchable within 10 s (p95) in the public index and 5 s (p95) in the shop search table, with the lag exported as a metric (AS-36).
- **FR-027**: Popularity is the damped bucket of clicks in the last 30 days, refreshed by a single-run, idempotent scheduled job that writes only changed buckets and never alters product fields or versions (AS-37, AS-86).
- **FR-028**: A resumable single-run job backfills shop state for shops that have products but no announced state, through the tenancy exported service in batches of at most 500 (AS-38).
- **FR-029**: Each projection records its idempotency mechanism (version-guarded upsert) and the maximum staleness it accepts; the staleness limits of FR-026 are the numbers the plan states (IX.7 R3).

**Reindex**

- **FR-030**: Search reads only through one live name that points at exactly one versioned index; the application never mutates an existing index on startup; on a first start with no live name it creates one empty versioned index (safe when two instances start together) (AS-49, AS-50).
- **FR-031**: A reindex or rollback is a run with status `QUEUED`, `BUILDING`, `CATCHING_UP`, `COMPLETED`, `FAILED`, `CANCELLED` and the legal transitions of AS-82; every transition is a conditional update with a history row; at most one run is active; `POST /admin/search/reindex`, `POST /admin/search/rollback`, `GET /admin/search/reindex`, `GET /admin/search/reindex/:runId`, `POST /admin/search/reindex/:runId/cancel` behave per AS-39, AS-42, AS-43, AS-46.
- **FR-032**: A run builds a new index with the current mapping version from the retained event history (the full stream from the start), writes every live projection change to the new index as well from the moment the run starts, carries over image, tier, sponsorship, popularity and shop state from the live index, and recomputes vectors only when the model version changed (AS-39, AS-41, AS-49).
- **FR-033**: Before the switch a verification gate compares the new index to the history's expected document count; a mismatch fails the run (AS-44).
- **FR-034**: The switch is one atomic operation (it also replaces a legacy concrete index); search never errors, never sees an empty index and never sees two (AS-40, AS-48).
- **FR-035**: A failed or cancelled run deletes its half-built index, stops parallel writes and leaves the live index untouched (AS-43, AS-44).
- **FR-036**: A run persists its replay position; a re-claimed job resumes; a crash between switch and completion record is recovered without a second switch (AS-45).
- **FR-037**: The previous index is retained for 24 hours and written in parallel; rollback is an atomic switch back; a retirement job deletes it afterwards and never deletes a live or in-use index (AS-46, AS-47).
- **FR-038**: Every index records its mapping version and embedding model version; the status endpoint reports `outdated` against the version the application expects (AS-49, AS-77).
- **FR-039**: A run also re-applies the replayed history to the shop search table under its version guard (AS-51).
- **FR-040**: Runs, transitions, durations and outcomes are recorded and emitted (`search.reindex_completed`, metrics, structured logs with `runId`) (AS-39, AS-44).
- **FR-041**: Every admin endpoint requires the administrator role (`401` / `403`) and every admin mutation is audit-logged with the actor (AS-52).

**Synonyms**

- **FR-042**: The synonym set is persisted and versioned; `GET /admin/search/synonyms` and `PUT /admin/search/synonyms {rules, expectedVersion}` implement the grammar (two-way comma rules, one-way `=>` rules, multi-word terms), limits (5,000 rules, 200 characters) and error codes of AS-55; the last 20 versions are kept 90 days (AS-53, AS-54, AS-55, AS-60, AS-83).
- **FR-043**: A change affects search-time matching of every document within 5 seconds without a reindex or document rewrite; a failed application leaves the old rules and version in force (AS-53, AS-58).
- **FR-044**: A concurrent edit with a stale `expectedVersion` answers `409 synonyms_version_conflict {currentVersion}`; an edit identical to the current rules answers `200 unchanged: true` without any engine call (AS-56, AS-57).
- **FR-045**: Indices built by a run use the current set (AS-59).

**Shop product search (P0308)**

- **FR-046**: `GET /shops/:shopId/products/search` requires membership with `products.read` and the tenancy status gate; the tenant is in the query predicate, never checked after loading; a non-member and an unknown shop get identical `404` (AS-63, AS-64).
- **FR-047**: `q` is required (1–100); matching is full-text first and a per-word trigram fallback when full-text finds nothing; `status` filters `ACTIVE` or `ARCHIVED`; `limit` 1–50 (default 25); paging by opaque cursor with deterministic order `rank` descending then `id` ascending (AS-61, AS-62, AS-65, AS-66).
- **FR-048**: The data is a relational full-text table owned by `discovery`, fed by the same events and guards as the public index (read model, no SQL on the catalog's tables); it includes archived products and the sandbox products of a sandbox shop; deleted products and deleted shops leave it (AS-67).
- **FR-049**: Input is matched literally; the fallback scans only the caller's shop; money is integer minor units (AS-68).
- **FR-050**: Shop search is rate limited by policy `discovery.shop-search` (120 per minute per user and shop, fail open) (AS-69).

**Relevance measurement**

- **FR-051**: Every search response carries `searchId`, a signed token valid 24 hours that embeds the normalised query (AS-01, AS-71).
- **FR-052**: Every search (HTTP or in-process) emits `search.performed` without blocking or failing the search; queries under two characters are not logged; emails, long digit runs and card-like numbers are redacted; the caller is a salted hash from a dedicated secret (AS-74, AS-75, AS-76).
- **FR-053**: `POST /search/clicks {searchId, productId, position 0–99}` accepts valid tokens only (`422 invalid_search_id` otherwise), answers `202`, and emits `search.result_clicked`; its consumer is idempotent and dead-letters invalid payloads; it is rate limited by `discovery.search-click` (300 per minute per address, fail open) (AS-70, AS-71, AS-72).
- **FR-054**: `GET /admin/search/quality?days=1–90&limit=1–100` reports `{query, searches, ctr, mrr, zeroResultRate}` per query, rounded to three decimals; invalid parameters answer `400` (AS-73).
- **FR-055**: Query and click rows expire after 90 days (AS-74).

**Platform and boundaries**

- **FR-056**: `ProductSearchService.search` is exported for in-process use by other domains (R1) with the visibility rules of the route, `limit ≤ 20` and no cursor (AS-78).
- **FR-057**: `ProductTitleSuggester.suggestTitles` is exported inside the `discovery` domain for S33, visible products only (AS-79).
- **FR-058**: This domain owns the search indices, the synonym set, the reindex runs and the shop search table; it issues no query on tables it does not own, injects no foreign model, and reads other domains only through R1 (`getShopsByIds`, `getReadyMediaByIds`) or R3 events; the generic engine client lives in infrastructure and is free of product knowledge; the barrel exports only modules, services and event contracts (AS-80).
- **FR-059**: Metrics: `search_requests_total{mode,status}`, `search_duration_seconds`, `search_degraded_total{reason}`, `search_unavailable_total`, `search_projection_lag_seconds`, `search_stale_events_ignored_total`, `search_ignored_total{reason}`, `search_reindex_duration_seconds`, `search_reindex_failed_total`, `search_events_dropped_total`; every log line carries `requestId` or `runId`; no query text outside the redacted event (AS-13, AS-20, AS-23, AS-36, AS-75).
- **FR-060**: Request and response shapes live in `packages/contracts` (`productSearchQuerySchema`, `productSearchResponseSchema`, `shopProductSearchQuerySchema`, `shopProductSearchResponseSchema`, `searchClickRequestSchema`, `synonymsPutRequestSchema`, `synonymsSchema`, `reindexRunSchema`, `searchIndexStatusSchema`, `searchQualityReportSchema`, `searchEventSchemas`); errors are problem+json with the codes named above.
- **FR-061**: Configuration is validated at startup: engine address and budgets (search 1 s, embedding 300 ms), refresh interval, the search-log secret, the signing key of `searchId`, retention windows.

### Key Entities

- **Search index (public)**: one document per non-deleted, non-sandbox product: product fields (guarded by `productVersion`), derived fields (in stock, vector, `embedding_pending`), signals (shop state, tier, image, sponsorship, popularity) each with its own guard, and a remembered-delete marker for 30 days. Owned by `discovery`.
- **Live name and versioned indices**: the live name points at one index; at most one previous index is retained for 24 hours.
- **Shop product search row**: one row per product per shop, tenant-scoped, with a full-text vector and the status; owned by `discovery`.
- **Shop state copy**: `{shopId, status, plan, shopVersion, lastEventAt}`; a copy of tenancy's data (IX.8); owned by `discovery`.
- **Reindex run**: `{runId, kind, status, mappingVersion, embeddingModelVersion, replayPosition, index, previousIndex, failureReason, timestamps}` plus a transition history; owned by `discovery`.
- **Synonym set**: `{version, rules, updatedBy, updatedAt}` and its last 20 versions; owned by `discovery`.
- **Search event, click event, quality row**: analytics facts in the click store; owned by `discovery`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 95% of searches answer in under 300 ms while the fleet serves 100,000 searches per second over a 50-million-product catalog (load proof outside the e2e suite).
- **SC-002**: A seller's change is visible to buyers within 10 seconds for 95% of changes and within 60 seconds for 99%, at 5,000 product changes per second.
- **SC-003**: A full reindex of the catalog causes zero failed searches and no visible dip in result counts; rolling back takes under one minute.
- **SC-004**: Replaying any permutation of a product's event history (duplicates included) always leaves the newest version; zero stale overwrites.
- **SC-005**: A synonym change takes effect for buyers within 5 seconds and needs no rebuild.
- **SC-006**: Zero hidden products (archived, sandbox, deleted, suspended or offboarding shop) appear in a sample of 10,000 searches against a deliberately polluted index.
- **SC-007**: Zero rows of another shop appear in any seller search across a cross-tenant test matrix.
- **SC-008**: An administrator reads click-through, mean reciprocal rank and zero-result rate for any query within one minute of asking, and no personal data appears in any stored query.
- **SC-009**: When the meaning service is down, 100% of semantic requests still return results (labelled degraded); when the search engine is down, callers get a clean retryable error within 1.1 seconds.
- **SC-010**: A buyer finds an intended product despite one typo in at least 95% of a curated typo test set.

## Assumptions

Each default is also one line in [`questions.md`](questions.md), tagged and sorted by impact.

- Decision policy: production-grade over cheapest; there are no external clients, so response shapes, parameters, module names and policies change freely, with `[BREAKING]` tags for the implementation.
- The notes' design is followed: the engine is a read model; the catalog's table is never read; versions are the event's `productVersion`; the live name is an alias over a versioned index; reindex = build beside, dual-write, verify, atomic switch, keep the old one.
- **Replay source**: the stream of `catalog.product_*` events keeps (by compaction per product or by long retention) at least the latest full snapshot of every product, including deletes (a `[CONTRACT]` with S05 and S53). Because events are full snapshots, the replay needs no other source for product fields.
- **Signals are not replayed**: image, tier, sponsorship, popularity and shop state are carried over from the live index (and kept current by dual-writing) because their streams are not retained for a rebuild.
- **Search is eventually consistent**: prices and stock in results can be a few seconds old; the product page and checkout re-read the catalog (notes, design 37).
- **Popularity** is derived from this capability's own result clicks, not from view counts (S05 does not emit views); the bucket formula is logarithmic with a cap of 10.
- **Boost default weights**: in stock ×2 (else ×1), rating `1 + rating/10`, popularity `1 + bucket/20`, tier `PRO` ×1.1 and `ENTERPRISE` ×1.2 (`STARTER` ×1), sponsored ×1.3, product capped to a total multiplier of 4; exact values are configuration and change only through a reviewed deploy.
- **Unknown shop = ACTIVE** until announced or backfilled; product events do not carry shop status.
- Brand and category filter values are compared exactly and case-sensitively, as the catalog stores them.
- One platform currency (S05); price bands are fixed in that currency's minor units (2,500 / 5,000 / 10,000).
- The relational full-text index is the right tool for per-shop search (small, scoped, cheap) and the search engine for catalog-wide search (notes 03/01 §9 and design 37).
- The embedding provider is replaceable behind a port; the default provider is deterministic and local so tests are hermetic; it is the only fake of the system edge besides identity and the engine's fault proxy. Dimension stays 64 until a model change.
- Search-engine refresh interval 5 s, bulk size 1,000, replicas and shard sizing as in the notes' capacity model (an operations concern in `plan.md`).
- The administrator role from S01 is enough for admin routes; a step-up requirement, if S02 adds one, is adopted without changing this spec.
- Language analyzers, "did you mean", highlighting, personalisation and geo ranking are not built.

## Cross-capability contracts

Specs already written were searched (`grep` over `specs/domains` for `S32` and `discovery`; `specs/web` and `specs/journeys` do not exist yet). Contracts they require from S32, and how they are honoured:

- **S05** requires S32 to host `GET /products/search` and `GET /shops/:shopId/products/search`, take over the search projector, the logging of searches and the `popularity` signal, consume the snapshot events (never the table), own `embedding` and `searchVector` data, and remove the D-15/D-16 coupling (honoured: FR-001, FR-017, FR-046–FR-048, FR-052, FR-058; two decisions differ and are `[CONTRACT]` questions: popularity comes from clicks, not from `getProductsByIds(...).viewCount`; the seller's list stays S05's).
- **S19** requires that S32 and S19 do not use each other's index (honoured: Out of scope).
- **S07** and **J04**: imported products become searchable through S05's events; S32 owns the staleness bound (honoured: FR-026, SC-002).
- **S03** (gaps) wants the sandbox check without `Shop` SQL: carried by `isSandbox` on the event (honoured: FR-021).
- **S29** names S32 as a consumer of `media.gallery_changed` (honoured: FR-023). **S30** (`video.ready`) and **S31** (`assets.digital_product_*`) list S32 as an optional consumer: not consumed here (`[CONTRACT]` question).
- **S25** excludes discussion search from S32 (honoured). **S11, S06** only name the D-15 cycle (honoured by FR-058: `catalog` no longer imports `discovery`).

**Provides** (exact names; exported from `@app/domains/discovery` unless it is an HTTP endpoint):

- HTTP under `/api`, problem+json errors with `code`, schemas in `packages/contracts`:
  - `GET /products/search` (anonymous) → `productSearchResponseSchema` = `{searchId, mode: 'browse' | 'lexical' | 'semantic', items: {id, shopId, title, brand, category, priceMinor, currency, rating, inStock, imageUrl: string | null, sponsored, position}[], total: {value, exact}, nextCursor: string | null, facets?: {categories, brands, priceRanges: {key, count}[], avgRating: number | null}, degraded: string[]}`; query `productSearchQuerySchema` (FR-001). **Consumers: W02 (search page, via the Next.js server), S46 (through `ProductSearchService`), J02, J04.**
  - `GET /shops/:shopId/products/search` (`products.read`) → `shopProductSearchResponseSchema` = `{items: {id, title, priceMinor, currency, quantity, status: 'ACTIVE' | 'ARCHIVED', rank}[], nextCursor}`. **Consumer: W04 (seller inventory search).**
  - `POST /search/clicks {searchId, productId, position}` → `202`. **Consumer: W02.**
  - Admin (`Role.ADMIN`): `GET /admin/search/index`, `POST /admin/search/reindex`, `GET /admin/search/reindex`, `GET /admin/search/reindex/:runId`, `POST /admin/search/reindex/:runId/cancel`, `POST /admin/search/rollback`, `GET /admin/search/synonyms`, `PUT /admin/search/synonyms`, `GET /admin/search/quality`. Removed from catalog (S05 AS-06, AS-87): the two search routes there; removed here: parameters `size`, `from`, `priceMin`, `priceMax`, `ratingMin` and response members `hits`, `suggestions`.
- `ProductSearchService` (R1): `search(request: { q?: string; filters?: { category?, brand?, minPriceMinor?, maxPriceMinor?, minRating?, inStock? }; sort?; semantic?: boolean; limit?: number (≤ 20); surface: 'internal' }): Promise<ProductSearchResponse>` with the HTTP response shape and visibility rules, no cursor, no facets. **Consumers: S46 (assistant tools).** Throws `SearchUnavailableError`.
- `ProductTitleSuggester` (exported inside the domain): `suggestTitles(prefix: string, size: number (≤ 10), signal?: AbortSignal): Promise<string[]>`, visible products only. **Consumer: S33.**
- Events (direct producer, not DB-originated; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`, `aggregateId` = `searchId`, topic key `searchId`): `search.performed` `{searchId, query, results, mode, userHash, filters: string[], degraded: string[], surface}`; `search.result_clicked` `{searchId, query, productId, position}`; and, published through the outbox with the run's transaction, `search.reindex_completed` `{runId, kind, index, previousIndex, documents, mappingVersion, finishedAt}`. **Consumers: S33 (`search.performed`, no ordering assumption), S35 (optional), operations dashboards (`search.reindex_completed`).**
- Index guarantees for S33 (same domain): the live name `products` and the sub-field `title.autocomplete` (edge n-grams) remain; autocomplete reads only through `ProductTitleSuggester`.
- Modules for the apps: `ProductSearchModule` (core: HTTP, R1 service, port), `SearchProjectorModule` (projector: product, shop, media, sponsorship consumers; click and query projectors), `SearchWorkerModule` (worker: reindex, retirement, popularity, backfills, tombstone purge). Nothing else is exported (no model, repository, projector or logger).
- Rate-limit policies (declared in S50's registry): `discovery.search.query` 120/minute per user or address (fail open); `discovery.shop-search` 120/minute per user and shop (fail open); `discovery.search-click` 300/minute per address (fail open); `discovery.search-admin` 30/minute per administrator (fail closed).
- Scheduled jobs (registered with S49, single-run): `search.reindex` (enqueued by the admin route), `search.retire-previous-index` (hourly), `search.refresh-popularity` (every 15 minutes), `search.backfill-shop-state` (resumable), `search.backfill-embeddings` (every 10 minutes while any `embedding_pending`), `search.purge-tombstones` (daily).
- Ownership (IX.3, for `docs/architecture/domain-map.md` and `db/ownership.ts`): `discovery` now owns four small relational tables (shop product search, shop state copy, reindex runs with history, synonym sets with history) in addition to its indices and analytics tables (a `[CONTRACT]` question).

**Requires**:

- **S05** (`catalog`): events on topic `products.events`, key `productId`, envelope `{eventId, type, version: 1, occurredAt, aggregateId}`, types `catalog.product_created|updated|archived|restored` with payload `{productId, shopId, title, description, brand, category, priceMinor, currency, rating, tags, quantity, inStock, status: 'ACTIVE' | 'ARCHIVED', isSandbox, externalSku, productVersion, createdAt, updatedAt, changedFields: string[]}` and `catalog.product_deleted {productId, shopId, productVersion}`. **Assumed beyond S05's text**: `productVersion` strictly increases per product including on delete; the topic retains the latest event per product (compaction) for replay; the catalog stops emitting `embedding` and `searchVector` data and drops those columns only after S32 is live.
- **S03** (`tenancy`): `ShopScoped('products.read')` with its status gate (`403 shop_suspended`, `409 shop_offboarding`, `404` for non-members and `DELETED`); events `tenancy.shop_status_changed v1 {shopId, from, to, reason?, shopVersion}`, `tenancy.shop_plan_changed v1 {shopId, plan, shopVersion}`, `tenancy.shop_offboarding_started v1 {shopId, purgeAt}`, `tenancy.shop_offboarding_cancelled v1 {shopId}`, `tenancy.shop_deleted v1 {shopId}`; `ShopQueryService.getShopsByIds(ids ≤ 500): Map<ShopId, ShopSummaryDto>` (R1) with `status` and `shopVersion` (and `plan` if present).
- **S29** (`media`): `media.gallery_changed v1 {productId, shopId, mediaIds: string[] (ordered), galleryVersion}` and `MediaQueryService.getReadyMediaByIds(ids ≤ 500)` (R1) returning `urls.thumb`; the media module must be loadable in the app that hosts the media consumer.
- **S36** (`marketing`): `marketing.product_sponsorship_changed v1 {productId, shopId, sponsored: boolean, sponsorshipVersion}` (a name proposed here; until S36 publishes it, no product is sponsored).
- **S53** (`infrastructure/projections`, `events`, `outbox`): consumer framework with envelope check, zod validation, per-key coalescing, version-guard helper, own consumer group, DLQ, backoff with jitter, and replay of a topic from the beginning with a persisted position and a separate consumer group; `outbox.append(event)` inside the domain's transaction for `search.reindex_completed`; the generic engine client split (D-16) is delivered by this capability under `libs/infrastructure`.
- **S49**: single-run scheduled jobs with leases and resumption (jobs above). **S50**: the four policies above. **S54**: problem+json filter with `code`, request context with `requestId`, metrics registry, config validation, graceful shutdown. **S01**: `Firewall({roles: [ADMIN]})` and the anonymous marker.
- **Click store** (analytics infrastructure): the existing `search_queries` and `search_clicks` tables with a 90-day expiry added.

## Review & Acceptance Checklist reference

The spec quality checklist is `checklists/requirements.md`; the test plan is `test-plan.md`; the implementation to-do list is `gaps.md`; every default chosen is in `questions.md`.
