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
- Jobs: `search.refresh-popularity`, `search.backfill-shop-state`, `search.retire-previous-index`. See {{concept:job-scheduler-lease}}.
- In-process ports: `ProductSearchService.search` (R1) and `ProductTitleSuggester.suggestTitles`.

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
- Policies: `discovery.search.query`, `discovery.shop-search`.

## Decisions
- The index is a read model of catalog events, so the catalog's table is never read (IX.7 R3).
- Each source has its own version guard, so any arrival order converges to the same document.
- Boosts are capped at a multiplier of 4, so text relevance always dominates.
- Search reads only through one live name that points at exactly one versioned index. The application never alters an existing index on startup.
- The previous index is kept for 24 hours and written in parallel, so rollback is an instant atomic switch.
- Synonyms apply at search time, so a change needs no reindex.
- Logging never blocks or fails a search.

## Known gaps
- Facets (AS-15 to AS-17), semantic search and its degradation (AS-18 to AS-21), embeddings at indexing: no test carries these scenario ids.
- Synonym endpoints (AS-53, AS-56 to AS-60): no test carries these ids. Only the grammar has tests (AS-54, AS-55, AS-83). Rules for validation, concurrency, idempotent replay and engine failure are not stated as rules.
- Shop search (AS-61 to AS-66, AS-68, AS-69): no test carries these ids; only lifecycle and freshness (AS-67) has one. Cross-tenant 404, the status gate and shop rate limit are unproven.
- Click, quality and privacy: AS-70, AS-71, AS-73, AS-74 and AS-76 have tests. AS-72 (consumer idempotency) and AS-75 (logging failure) have none.
- Run behaviors AS-43, AS-48 to AS-51 have tests, but no rule here states them. Cancel, legacy concrete index, mapping version, first start and shop-table rebuild are listed only by their proof ids.
- Backfill (AS-38), popularity job (AS-37) and freshness bounds (AS-36) have tests, but no rule here states the 10 s and 5 s bounds.
- Exported services (AS-78, AS-79) and boundary checks (AS-80) have no test with an id.
- The facts list no code excerpts for the search service, controllers or consumers, so most rules carry no `` clause.

### Claims the generator could not verify (removed from the rules above)
- code ref `...` (file not found: ...)
