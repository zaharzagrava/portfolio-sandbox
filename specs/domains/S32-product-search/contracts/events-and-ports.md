# Events, exported services, jobs and configuration: S32

## Entry point `@app/domains/discovery` (S32 additions; existing S33–S35 exports unchanged)

- Modules: `ProductSearchModule` (core), `SearchProjectorModule` (projector), `SearchWorkerModule` (worker).
- Services: `ProductSearchService.search(request): Promise<ProductSearchResponse>` (`surface: 'internal'`, `limit ≤ 20`, no cursor, no facets, throws `SearchUnavailableError` and a validation error), `ProductTitleSuggester.suggestTitles(prefix, size ≤ 10, signal?)` (typed `SuggestionTimeoutError`).
- Types/contracts: DTO types from `packages/contracts`, `SearchPerformed`, `SearchResultClicked`, `SearchReindexCompleted` event definitions.
- **Removed from the barrel**: `SearchAdminModule`, `SearchReindexWorkerModule`, `SearchQueryLogger`, `SearchClicksProjector`, `SearchQueriesProjector`. `OrderBasketsProjector` and `TrendingConsumer` stay (S34/S35 own them).

## Produced events (envelope `{eventId, type, version: 1, occurredAt, aggregateId}`)

| Type | Topic / key | Path | Payload |
|---|---|---|---|
| `search.performed` | `search.events` / `searchId` | direct, fire-and-forget, drop counter | `{searchId, query, results, mode, userHash, filters: string[], degraded: string[], surface}` |
| `search.result_clicked` | `search.events` / `searchId` | direct | `{searchId, query, productId, position}` |
| `search.reindex_completed` | `search.events` / `runId` | outbox, run transaction | `{runId, kind, index, previousIndex, documents, mappingVersion, finishedAt}` |

## Consumed events

| Group | Topic | Types | Guard |
|---|---|---|---|
| `search-indexer` | `products.events` | `catalog.product_created|updated|archived|restored|deleted` | `productVersion` (`aggregateVersion`) |
| `search-shop-state` | `shop.events` | `tenancy.shop_status_changed`, `shop_plan_changed` (`shopVersion`); `shop_offboarding_started|cancelled`, `shop_deleted` (`occurredAt`) | `shopVersion` or `occurredAt` |
| `search-media` | media topic | `media.gallery_changed v1 {productId, shopId, mediaIds, galleryVersion}` | `galleryVersion` |
| `search-sponsorship` | marketing topic | `marketing.product_sponsorship_changed v1 {productId, shopId, sponsored, sponsorshipVersion}` | `sponsorshipVersion` |
| `search-clicks`, `search-queries` | `search.events` | click / performed rows into ClickHouse | `eventId` uniqueness |

Unknown types: acknowledged, `search_ignored_total{reason="unknown_type"}`. Invalid payload or unsupported envelope version: DLQ, no side effect.

## Jobs (S49, single-run, idempotent; `declareJobType` with payload contract)

| Name | Schedule | Payload | Notes |
|---|---|---|---|
| `search.reindex` | enqueued by the admin route | `{runId}` | long lease with heartbeat, resumes from the run row |
| `search.retire-previous-index` | hourly | `{}` | deletes the retained index after 24 h, never the live or an active target; re-pushes committed synonyms if the engine copy differs |
| `search.refresh-popularity` | every 15 min | `{}` | writes changed buckets only |
| `search.backfill-shop-state` | on demand / resumable | `{cursor?}` | `getShopsByIds` ≤ 500 per call |
| `search.backfill-embeddings` | every 10 min while pending | `{}` | batch-limited |
| `search.purge-tombstones` | daily | `{}` | tombstones older than 30 d (index and table) |

## Rate-limit policies (S50 registry)

`discovery.search.query` 120/min user-or-IP fail open · `discovery.shop-search` 120/min user+shop fail open · `discovery.search-click` 300/min IP fail open · `discovery.search-admin` 30/min admin fail closed.

## Configuration keys (validated at startup, FR-061)

`search_log_secret` (must differ from `jwt_secret`), `search_id_signing_key`, `search_budget_ms` (1000), `embedding_budget_ms` (300), `search_refresh_interval` (5s), `search_tombstone_retention_days` (30), `search_previous_index_retention_hours` (24), `search_boost_weights` (defaults of the spec, cap 4), engine address (existing).

## Ports (`domain/ports.ts`, injection tokens exported from `domain/`)

`ProductIndexPort`, `ShopSearchRepository`, `ReindexRunRepository`, `SynonymSetRepository`, `ShopStateRepository`, `EmbeddingProvider`, `ProductImageResolver`, `SearchEventPublisher`, `Clock`.

## Metrics (S54 registry)

`search_requests_total{mode,status}`, `search_duration_seconds`, `search_degraded_total{reason}`, `search_unavailable_total`, `search_projection_lag_seconds`, `search_stale_events_ignored_total`, `search_ignored_total{reason}`, `search_reindex_duration_seconds`, `search_reindex_failed_total`, `search_events_dropped_total`.
