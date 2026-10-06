# SD-37 — Product Search: Index Sync, Zero-Downtime Reindex, Relevance

Status: ☑ done (typechecked; spec written, not run) · Phase 3 · Depends on: F-05 · Extends README #7, #13–#17

## Marketplace adaptation
Search exists (fuzzy, BM25 boosts, autocomplete, facets, k-NN). Missing at scale: **out-of-order safe indexing**, **zero-downtime full reindex** (mapping changes), relevance business boosts, consistency rules.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Index with **external versioning** (`version_type=external`, version = product.version) — stale events ignored | 10/09 #37 |
| **Alias swap reindex**: build `products_v{n+1}` from snapshot + replay Kafka from snapshot offset → atomic alias switch → drop old | 10/09 #37 |
| Business boosts: `function_score` (in stock, rating, shop plan tier, sponsored flag from SD-32) | 10/09 #37 |
| Synonyms (search-time synonym set, e.g. "airpods ↔ earbuds") updatable without reindex | 10/09 #37 |
| Filters in `filter` context (cached, unscored) | 10/09 #37 |
| Click-through logging for relevance evaluation (SD-31) | 10/09 #37 |
| Postgres FTS (`tsvector` + GIN + `pg_trgm`) documented as the "small catalog" alternative (shop-internal admin search uses it) | 03/01 §9 |

## Steps
- [x] Migrate indexer to F-05 `EsSink` with external versions.
- [x] Reindex CLI/job with alias swap.
- [x] `function_score` + synonyms analyzer.
- [x] Shop admin product search via Postgres FTS (GIN + trigram) inside the shop context.
- [x] e2e: deliver version 3 then version 2 → index keeps 3; reindex keeps search answering throughout.

## Scale
- Target: 100k RPS search (D25), 50M products, 5k product updates/s.
- Hot path: ES only; Postgres never queried by buyers' search.
- First bottleneck & fix: indexing load during sales (price updates) → bulk 1k docs, `refresh_interval: 5s`; query load → replicas + shard per ~30 GB.
- Capacity model: 50M docs × 2 KB = 100 GB → 4 primary shards × 2 replicas; ~25k QPS per 3 data nodes → 12 data nodes for 100k RPS.
- Proof: k6 existing `loadtest:search` + reindex-during-load scenario (error rate 0).

## Implementation notes (2026-10-01)
- `products` is now an **alias** over `products_v<ts>` (`ElasticsearchService.ensureProductsIndex` / `productsIndexDefinition`). Search-time `synonym_graph` backed by the ES Synonyms API set `product-synonyms` (`updateSynonyms` reloads analyzers, no reindex). Mapping adds `inStock` and `popularity`, fed by `ProductSearchProjector`.
- Ranking: `function_score` over BM25. In-stock gets ×2 weight; rating and popularity are added with `log1p` damping.
- `SearchReindexService` (job `search.reindex-products`, apps/worker):
  - Builds the new index in bulk-load mode with keyset batches and `external_gte` versions.
  - Switches to serving settings, then does an atomic `_aliases` swap. The swap also migrates a legacy concrete index.
  - Catches up on rows updated since T0 and keeps one previous index for rollback.
- Shop-admin search on Postgres: migration `20261001220000-product-fts` adds a trigger-maintained `searchVector` instead of a STORED generated column, so there's no table rewrite. It backfills in batches and creates GIN + `pg_trgm` indexes CONCURRENTLY. `ShopProductSearchService` tries FTS first, then falls back to trigram matching.
- Quality: `POST /api/search/clicks` writes to ClickHouse `search_clicks` via `SearchClicksProjector`. `GET /api/admin/search/quality` reports CTR, MRR and zero-result rate per query.
- Admin endpoints: `PUT /api/admin/search/synonyms` and `POST /api/admin/search/reindex`.
- Spec: `search-admin/search-reindex.e2e-spec.ts`.
