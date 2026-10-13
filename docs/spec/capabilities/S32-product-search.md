---
id: S32
title: Product search: index sync with external versioning, zero-downtime reindex, relevance boosts, synonyms, facets, k-NN
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S03, S05, S49, S50, S53, S54]
concepts: [search-index, projection-and-replay, problem-json-errors, rate-limit-policy, job-scheduler-lease, tenant-shop-rbac, outbox-task-queue]
models: []
scope:
  - packages/contracts/src/search/**
---
# S32 - Product search: index sync with external versioning, zero-downtime reindex, relevance boosts, synonyms, facets, k-NN

## Purpose
Buyers need to find products by text. Sellers need to find their own products by text. This capability answers both, and it keeps the answers correct. The {{concept:search-index}} is a read model built only from catalog events; the catalog's table is never read. See {{concept:projection-and-replay}}.

## Entry points
- `GET /products/search`: public product search. It covers full-text with typo tolerance, filters, sort, cursor paging, facets and semantic mode. Anonymous callers are allowed.
- `GET /shops/:shopId/products/search`: a shop member searches the shop's own products (read permission, tenancy status gate). See {{cap:S03}}.
- `POST /search/clicks`: records a click on a result; answers `202`.
- `POST /admin/search/reindex`: starts a zero-downtime reindex run. Administrator only.
- `POST /admin/search/reindex/{runId}/cancel`: cancels an active run.
- `POST /admin/search/rollback`: switches the live name back to the previous index.
- `GET /admin/search/index`: index status (mapping version, `outdated`, document count, lag).
- `GET` and `PUT /admin/search/synonyms`: read and replace the synonym rules.
- `GET /admin/search/quality`: per-query report of searches, click-through rate, MRR and zero-result rate.
- Event consumers: `catalog.product_*`, `tenancy.shop_*`, `marketing.product_sponsorship_changed`, `media.gallery_changed` and `search.result_clicked`.
- Jobs: `search.reindex`, `search.retire-previous-index`, `search.refresh-popularity`, `search.backfill-shop-state`, `search.backfill-embeddings`, `search.purge-tombstones`. See {{concept:job-scheduler-lease}}.
- In-process ports: `ProductSearchService.search` (R1), and `ProductTitleSuggester.suggestTitles` with its typo-tolerant `suggestTitlesFuzzy` for {{cap:S33}}.

## Rules
- **S32.R-01** The public search route MUST answer anonymous callers with `200`, never `401`, and with the same visibility as authenticated callers. [proof: S32 AS-12]
- **S32.R-02** A search response MUST carry `Cache-Control: private, no-store` and MUST parse with `productSearchResponseSchema`. [proof: S32 AS-01] [code: packages/contracts/src/search/product-search.ts#productSearchQuerySchema]
- **S32.R-03** The route MUST reject unknown or invalid parameters (for example `limit` outside 1–50, `q` over 100 characters, `minRating` outside 0–5) with `400 validation_failed`. [proof: S32 AS-10]
- **S32.R-04** Operators, wildcards, quotes and field syntax in `q` MUST be matched as plain words, and every such call MUST answer `200`. [proof: S32 AS-11, S32 AS-85]
- **S32.R-05** Matching MUST tolerate typos, MUST rank exact matches above fuzzy ones, and MUST order field weights title, brand, description, tags. [proof: S32 AS-02, S32 AS-03]
- **S32.R-06** Archived, sandbox, deleted products and products of `SUSPENDED`, `DELETING` or `DELETED` shops MUST NOT appear in items, totals, facets or semantic results. [proof: S32 AS-07]
- **S32.R-07** The combined business multiplier MUST stay within `[1, 4]`, so an exact text match outranks a weak match with every boost. [proof: S32 AS-06, S32 AS-86]
- **S32.R-08** Filters MUST combine with AND and MUST NOT change the relative order of the remaining items. [proof: S32 AS-14]
- **S32.R-09** Every sort order MUST end in `id` ascending, so the order is total. [proof: S32 AS-08]
- **S32.R-10** Paging MUST use an opaque cursor bound to `(q, filters, sort, mode)`. Altered or mismatched cursors MUST fail with `invalid_cursor`. [proof: S32 AS-09, S32 AS-84]
- **S32.R-11** When the engine is unreachable or exceeds the 1 s budget, search MUST answer `503` with `code: "search_unavailable"` and `Retry-After: 1`. [proof: S32 AS-13]
- **S32.R-12** Search MUST be limited by policy `discovery.search.query` (120 per minute per user or address); excess calls MUST answer `429` with `Retry-After`. See {{concept:rate-limit-policy}}. [proof: S32 AS-12]
- **S32.R-13** An incoming product event MUST be applied when its version is at least the stored version and MUST be ignored and counted when lower. [proof: S32 AS-23, S32 AS-24, S32 AS-81]
- **S32.R-14** A deleted product MUST stay hidden when late events arrive with a version at or below the delete version. [proof: S32 AS-26]
- **S32.R-15** A sandbox product MUST NOT enter the public index. [proof: S32 AS-27]
- **S32.R-16** A suspended or offboarding shop MUST hide all its products, including products created later. [proof: S32 AS-28, S32 AS-29]
- **S32.R-17** Invalid or unsupported-version messages MUST be dead-lettered with no change to the index. [proof: S32 AS-33]
- **S32.R-18** At most one reindex run MUST be active; a second start or rollback MUST answer `409 reindex_in_progress`. [proof: S32 AS-42]
- **S32.R-19** Run transitions MUST be only the legal pairs of the run state machine; any other pair MUST be `invalid_transition`. [proof: S32 AS-82] [code: packages/contracts/src/search/admin.ts#REINDEX_STATUSES]
- **S32.R-20** A verification gate MUST fail a run with `verification_failed` when the new index holds fewer documents than the history requires; the live index MUST stay untouched. [proof: S32 AS-44]
- **S32.R-21** Every admin endpoint MUST answer `401` without credentials and `403` without the administrator role. [proof: S32 AS-52]
- **S32.R-22** With `facets=true` the response MUST carry `facets` with `categories` and `brands` (top 20 by count descending, then key ascending), `priceRanges` (always `under_25`, `25_to_50`, `50_to_100`, `over_100` in that order) and `avgRating` (mean rounded to two decimals, `null` when nothing matches), counted over all matches and not over the page. [proof: S32 AS-15, S32 AS-17]
- **S32.R-23** A facet MUST ignore the selection of its own group (category, brand or price) and MUST respect every other filter; `inStock` and `minRating` apply to every facet. Without `facets=true` the response MUST have no `facets` key. [proof: S32 AS-16, S32 AS-17]
- **S32.R-24** With `semantic=true` the route MUST require `q` (`422 semantic_requires_query`), MUST refuse `facets` and `cursor` (`422 unsupported_combination` with `parameters`), and MUST return the `limit` nearest visible products that have a vector, with the filters applied before the neighbours are chosen. [proof: S32 AS-18, S32 AS-19]
- **S32.R-25** When the embedding provider takes longer than 300 ms or fails, a semantic search MUST answer `200` with lexical results, `mode: "lexical"` and `degraded: ["semantic_unavailable"]`, count `search_degraded_total`, and never answer `5xx`. [proof: S32 AS-20]
- **S32.R-26** A vector MUST be computed only when title, description, brand, category or tags change; a provider failure MUST index the product without a vector and mark it pending until the `search.backfill-embeddings` job fills it; a vector MUST NOT appear in any response. [proof: S32 AS-21]
- **S32.R-27** `PUT /admin/search/synonyms {rules, expectedVersion}` MUST accept two-way rules (`a, b`), one-way rules (`a => b`) and multi-word terms; a break of the grammar (more than 5,000 rules, over 200 characters, empty, fewer than two terms, empty side, disallowed characters, duplicate, cycle) MUST answer `422 invalid_synonym_rules` with `errors: [{index, code}]` and leave the rules and the version unchanged; a body of the wrong shape MUST answer `400 validation_failed`. [proof: S32 AS-54, S32 AS-55, S32 AS-83]
- **S32.R-28** A synonym edit MUST apply to the search of every document within 5 seconds without a reindex, and the rules MUST survive a reindex. [proof: S32 AS-53, S32 AS-59]
- **S32.R-29** Of two concurrent synonym edits with the same `expectedVersion` exactly one MUST succeed; the other MUST answer `409 synonyms_version_conflict {currentVersion}`, and so MUST every stale `expectedVersion`. [proof: S32 AS-56]
- **S32.R-30** A synonym edit identical to the current rules MUST answer `200` with `unchanged: true`, keep the version and make no engine call. [proof: S32 AS-57]
- **S32.R-31** When the engine refuses a synonym edit the route MUST answer `503 search_unavailable` and the rules and the version MUST stay as they were. [proof: S32 AS-58]
- **S32.R-32** `GET /admin/search/synonyms` MUST return `{version, rules, updatedAt, updatedBy}`; every successful edit MUST write an audit line `{actorId, version, ruleCount}`; the history MUST keep the last 20 versions for 90 days and never drop the current one. [proof: S32 AS-60]
- **S32.R-33** `GET /shops/:shopId/products/search` MUST require a member with `products.read`: no credentials answer `401`, a non-member and an unknown shop answer the same `404`, a `SUSPENDED` shop `403 shop_suspended`, a `DELETING` shop `409 shop_offboarding`, a `DELETED` shop `404`. [proof: S32 AS-63, S32 AS-64]
- **S32.R-34** Shop search MUST require `q` (1 to 100 characters), accept `status` (`ACTIVE` or `ARCHIVED`) and `limit` (1 to 50, default 25), and answer `400 validation_failed` otherwise; a cursor that was altered or came from another shop or query MUST answer `422 invalid_cursor`. [proof: S32 AS-65]
- **S32.R-35** Shop search MUST list archived products with their status, order by rank descending then `id` ascending with a keyset cursor, and fall back to a per-word trigram match when full text finds nothing. [proof: S32 AS-61, S32 AS-62, S32 AS-66]
- **S32.R-36** Shop search MUST reflect create, rename, archive, restore and delete at once, include the products of a sandbox shop in that shop only, and hold no row of a deleted shop. [proof: S32 AS-67]
- **S32.R-37** Shop search MUST match `q` literally, whatever quotes, operators or backslashes it holds. [proof: S32 AS-68]
- **S32.R-38** Shop search MUST be limited by policy `discovery.shop-search` (120 per minute per user and shop, fail open). [proof: S32 AS-69]
- **S32.R-39** `POST /search/clicks {searchId, productId, position 0–99}` MUST answer `202` with an empty body and emit `search.result_clicked` with the query carried by the signed `searchId`; a forged, altered, expired or missing `searchId` MUST answer `422 invalid_search_id`, any other bad field `400 validation_failed`, and the route MUST be limited by policy `discovery.search-click` (300 per minute per address). [proof: S32 AS-70, S32 AS-71]
- **S32.R-40** The click consumer MUST store one row per delivered event and MUST dead-letter an invalid payload without a row. [proof: S32 AS-72]
- **S32.R-41** `GET /admin/search/quality?days=1–90&limit=1–100` MUST report `{query, searches, ctr, mrr, zeroResultRate}` per query, most searched first, rounded to three decimals, and MUST answer `400 validation_failed` outside those ranges without clamping. [proof: S32 AS-73]
- **S32.R-42** A logged query holding an email, a run of nine or more digits or a card-like number MUST be stored as `[redacted]` with its result count, and the query and click tables MUST expire rows after 90 days. [proof: S32 AS-74]
- **S32.R-43** When the event stream is down a search MUST still answer `200` and a click `202`, and `search_events_dropped_total` MUST rise. [proof: S32 AS-75]
- **S32.R-44** Every logged search MUST emit `search.performed` with `searchId`, `query`, `results`, `mode`, `userHash`, the filter names, `degraded` and `surface`, and it MUST parse with the contract in `packages/contracts`. [proof: S32 AS-76] [code: packages/contracts/src/search/events.ts#searchEventSchemas]
- **S32.R-45** `ProductSearchService.search` MUST be exported for other domains with the visibility of the route, `limit` of at most 20, no cursor, no facets and `surface: "internal"`. [proof: S32 AS-78]
- **S32.R-46** `ProductTitleSuggester.suggestTitles` MUST return at most `size` (1 to 10) titles of visible products and MUST fail with `SuggestionTimeoutError` when its signal aborts or the engine does not answer. [proof: S32 AS-79]
- **S32.R-47** The barrel of the domain MUST export no projector, consumer, logger or model, the search code MUST import no foreign model and issue no SQL on a table it does not own, and `check:boundaries` and `check:table-ownership` MUST report nothing for it. [proof: S32 AS-80]

## Behaviors
- **S32.B-01** Given three visible products and `q=iphone`, when an anonymous caller searches, then the response is `200` with matching items and a `searchId`. [proof: S32 AS-01]
- **S32.B-02** Given `q=iphnoe` or `q=aipods`, when searched, then the iPhone case or AirPods are returned; `q=xpone` returns `items: []`. [proof: S32 AS-02]
- **S32.B-03** Given no `q`, when searched, then `mode` is `browse` and items follow the business score descending, then `id` ascending. [proof: S32 AS-04]
- **S32.B-04** Given two products equal except for stock, rating, popularity, plan tier or sponsorship, when searched, then the one with the stronger signal ranks higher. [proof: S32 AS-05]
- **S32.B-05** Given 45 matching products and `limit=20`, when the caller follows `nextCursor`, then pages hold 20, 20 and 5 items with no duplicate and the last `nextCursor` is `null`. [proof: S32 AS-09]
- **S32.B-06** Given products with prices 100, 100, 250, 500, 900, when sorted by `price-asc`, `price-desc` or `newest`, then each order is as named, with ties by `id` ascending. [proof: S32 AS-08]
- **S32.B-07** Given `v3` then a late `v2` for a product, when both arrive, then the index keeps `v3` and counts the stale event. [proof: S32 AS-23]
- **S32.B-08** Given the same event delivered twice, when projected, then the index holds one unchanged document. [proof: S32 AS-24]
- **S32.B-09** Given an archived product, when a late older update arrives, then it stays hidden; a later restore shows it again. [proof: S32 AS-25]
- **S32.B-10** Given a shop moves to `SUSPENDED`, when the event is projected, then none of its products appear in public search. [proof: S32 AS-28]
- **S32.B-11** Given a plan change to `PRO`, when projected, then the shop's products carry the tier boost. [proof: S32 AS-30]
- **S32.B-12** Given a sponsorship event, when projected, then the item shows `sponsored: true`; a late older event is ignored. [proof: S32 AS-31]
- **S32.B-13** Given a gallery event with `mediaIds: [m1, m2]`, when projected, then `imageUrl` is the thumbnail of `m1`. [proof: S32 AS-32]
- **S32.B-14** Given 30 updates for one product in one batch, when processed, then the engine receives one write carrying the latest version. [proof: S32 AS-34]
- **S32.B-15** Given the engine is down during projection, when a batch arrives, then it is not acknowledged and is retried; no event is lost. [proof: S32 AS-35]
- **S32.B-16** Given an admin calls `POST /admin/search/reindex`, when it runs, then it answers `202 QUEUED` and the run moves `QUEUED → BUILDING → CATCHING_UP → COMPLETED`. [proof: S32 AS-39]
- **S32.B-17** Given a client searching during a run, when the run switches indices, then every search answers `200` and the total never drops. [proof: S32 AS-40]
- **S32.B-18** Given changes made while a run is `BUILDING`, when it completes, then the new index reflects them all. [proof: S32 AS-41]
- **S32.B-19** Given a completed run with the previous index retained, when an admin calls rollback, then the live name points back atomically; after 24 hours the previous index is deleted and rollback answers `409 no_previous_index`. [proof: S32 AS-46, S32 AS-47]
- **S32.B-20** Given a worker stops mid-build, when another worker claims the job, then the run resumes from its saved position. [proof: S32 AS-45]
- **S32.B-21** Given 30 matching products in 3 categories and `limit=5`, when a caller asks for `facets=true`, then the facet counts add up to 30 although the page holds 5 items. [proof: S32 AS-15]
- **S32.B-22** Given `category=shoes&facets=true`, when searched, then items are shoes only and the `categories` facet still lists every category. [proof: S32 AS-16]
- **S32.B-23** Given "Alpine Parka" and "Garden Hose 20 m", when a caller searches `q=winter coat&semantic=true`, then the parka ranks first and `mode` is `semantic`. [proof: S32 AS-18]
- **S32.B-24** Given the embedding provider is down, when `q=winter coat&semantic=true` is searched, then lexical items return with `degraded: ["semantic_unavailable"]`. [proof: S32 AS-20]
- **S32.B-25** Given a price-only update of a product, when it is projected, then the embedding provider is not called. [proof: S32 AS-21]
- **S32.B-26** Given "AirPods Pro" and the rule `airpods, earbuds`, when an administrator saves the rule at the current version, then `q=earbuds` finds it within 5 seconds and the version rises by one. [proof: S32 AS-53]
- **S32.B-27** Given the rules `tv => television` and `sneakers, trainers`, when searched, then `q=tv` finds "Television 55 inch", `q=television` does not find "TV Stand 55 inch", and `q=trainers` finds "Sneakers Pro". [proof: S32 AS-54]
- **S32.B-28** Given a shop member and the query `iphone case`, when the member searches the shop, then the active and the archived iPhone cases are listed, the archived one with `status: "ARCHIVED"`. [proof: S32 AS-61]
- **S32.B-29** Given the query `iphnoe cse`, when a member searches the shop, then "iPhone 17 Pro Case" is found. [proof: S32 AS-62]
- **S32.B-30** Given 60 products matching `cable` and `limit=25`, when a member follows `nextCursor`, then pages hold 25, 25 and 10 items with no duplicate. [proof: S32 AS-66]
- **S32.B-31** Given a search for `iphone` and a click at position 0, when the click is posted with the response's `searchId`, then it answers `202` and one click row exists after projection. [proof: S32 AS-70]
- **S32.B-32** Given 10 searches for `iphone` (2 without results) and 4 clicks at positions 0, 0, 1 and 4, when an administrator reads the report, then the row is `searches: 10`, `ctr: 0.4`, `mrr: 0.27`, `zeroResultRate: 0.2`. [proof: S32 AS-73]

## Lifecycles
Reindex run statuses: `QUEUED`, `BUILDING`, `CATCHING_UP`, `COMPLETED`, `FAILED`, `CANCELLED`. Legal moves include `QUEUED → BUILDING`, `QUEUED → CANCELLED`, `BUILDING → CATCHING_UP`, `BUILDING → FAILED`, `BUILDING → CANCELLED`, `CATCHING_UP → COMPLETED` and `CATCHING_UP → FAILED`. The facts truncate the rest of the list. A worker moves a run along; an administrator may cancel an active run. No model file exists for this capability.

## Owns
- The search indices and the live name that points at one versioned index.
- The synonym set (versioned) and the reindex runs with their history.
- The shop search table (relational full-text).
- The search query and click logs (rows expire after 90 days).
- Events emitted: `search.performed`, `search.result_clicked`, `search.reindex_completed`.
- Metrics: `search_requests_total`, `search_unavailable_total`, `search_degraded_total`, `search_stale_events_ignored_total`, `search_ignored_total`, `search_projection_lag_seconds`.
- Configuration: engine address, search budget 1 s, embedding budget 300 ms, refresh interval, search-log secret, `searchId` signing key, retention windows.
- Policies: `discovery.search.query`, `discovery.shop-search`, `discovery.search-click`, `discovery.search-admin`.

## Decisions
- The index is a read model of catalog events, so the catalog's table is never read (IX.7 R3).
- Each source has its own version guard, so any arrival order converges to the same document.
- Boosts are capped at a multiplier of 4, so text relevance always dominates.
- Search reads only through one live name that points at exactly one versioned index. The application never alters an existing index on startup.
- The previous index is kept for 24 hours and written in parallel, so rollback is an instant atomic switch.
- Synonyms apply at search time, so a change needs no reindex.
- Logging never blocks or fails a search.

## Known gaps
- A shop id that is not a UUID answers `404` (the tenancy guard of {{cap:S03}} hides it like an unknown shop), not the `400 validation_failed` that AS-65 of the specification names.
- The load figures (100,000 searches per second over 50 M products, 5,000 product changes per second) have no automated test; they are ops artifacts.
- Run behaviors AS-43, AS-48 to AS-51 have tests, but no rule here states them. Cancel, legacy concrete index, mapping version, first start and shop-table rebuild are listed only by their proof ids.
- Backfill (AS-38), popularity job (AS-37) and freshness bounds (AS-36) have tests, but no rule here states the 10 s and 5 s bounds.
- Exported services (AS-78, AS-79) and boundary checks (AS-80) have no test with an id.
- The facts list no code excerpts for the search service, controllers or consumers, so most rules carry no `` clause.

### Claims the generator could not verify (removed from the rules above)
- code ref `...` (file not found: ...)
