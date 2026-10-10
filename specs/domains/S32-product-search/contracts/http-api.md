# HTTP contracts: S32 (all under `/api`, errors are `application/problem+json` with `type, title, status, detail, instance, requestId, code`)

Schemas live in `packages/contracts/src/search/`; names below are the exported zod schemas (FR-060). Unknown query parameters or body fields answer `400 validation_failed` (one entry per offending field).

## Public

### GET /products/search — anonymous
- Query (`productSearchQuerySchema`): `q?` (≤ 100 after normalisation), `category?`, `brand?` (≤ 100), `minPriceMinor?`, `maxPriceMinor?` (integers ≥ 0), `minRating?` (0–5), `inStock?` (`true|false` only), `sort?` (`relevance|price-asc|price-desc|newest`), `facets?` (`true|false`), `semantic?` (`true|false`), `limit?` (1–50, default 20), `cursor?`.
- 200 (`productSearchResponseSchema`): `{searchId, mode: 'browse'|'lexical'|'semantic', items: [{id, shopId, title, brand, category, priceMinor, currency, rating, inStock, imageUrl, sponsored, position}], total: {value, exact}, nextCursor, facets?: {categories, brands, priceRanges, avgRating}, degraded: string[]}`; header `Cache-Control: private, no-store`.
- Errors: `400 validation_failed`; `422 invalid_price_range | invalid_cursor | semantic_requires_query | unsupported_combination`; `429` + `Retry-After` (policy `discovery.search.query`); `503 search_unavailable` + `Retry-After: 1`.

### POST /search/clicks — anonymous
- Body (`searchClickRequestSchema`): `{searchId, productId (uuid), position (int 0–99)}`.
- `202` empty body. `400 validation_failed`; `422 invalid_search_id`; `429` (policy `discovery.search-click`).

## Shop scoped

### GET /shops/:shopId/products/search — `ShopScoped('products.read')`
- Query (`shopProductSearchQuerySchema`): `q` (required, 1–100), `status?` (`ACTIVE|ARCHIVED`), `limit?` (1–50, default 25), `cursor?`.
- 200 (`shopProductSearchResponseSchema`): `{items: [{id, title, priceMinor, currency, quantity, status, rank}], nextCursor}`.
- Errors: `400 validation_failed`; `401`; `403 shop_suspended`; `404` (non-member, unknown, `DELETED`, identical bodies); `409 shop_offboarding`; `422 invalid_cursor`; `429` (policy `discovery.shop-search`).

## Admin (`Firewall({roles: [ADMIN]})`; `401` without credentials, `403` otherwise; policy `discovery.search-admin`, fail closed)

| Route | Request | Success | Errors |
|---|---|---|---|
| `GET /admin/search/index` | — | `searchIndexStatusSchema` (AS-77) | — |
| `POST /admin/search/reindex` | empty | `202 {runId, kind: 'REINDEX', status: 'QUEUED'}` | `409 reindex_in_progress {runId}` |
| `GET /admin/search/reindex` | `?limit` 1–50, `?cursor` | `{items: reindexRunSchema[], nextCursor}` | `422 invalid_cursor` |
| `GET /admin/search/reindex/:runId` | uuid | `reindexRunSchema` | `400`, `404 run_not_found` |
| `POST /admin/search/reindex/:runId/cancel` | — | `200 reindexRunSchema` (`status: 'CANCELLED'`) | `400`, `404 run_not_found`, `409 invalid_transition` |
| `POST /admin/search/rollback` | — | `202 {runId, kind: 'ROLLBACK', status: 'QUEUED'}` | `409 reindex_in_progress {runId}`, `409 no_previous_index` |
| `GET /admin/search/synonyms` | — | `synonymsSchema` `{version, rules, updatedAt, updatedBy}` | — |
| `PUT /admin/search/synonyms` | `synonymsPutRequestSchema` `{rules: string[], expectedVersion: int}` | `200 {version, ruleCount, updatedAt, unchanged}` | `400`, `409 synonyms_version_conflict {currentVersion}`, `422 invalid_synonym_rules {errors: [{index, code}]}`, `503 search_unavailable` |
| `GET /admin/search/quality` | `days` 1–90 (default 7), `limit` 1–100 (default 50) | `searchQualityReportSchema` rows `{query, searches, ctr, mrr, zeroResultRate}` | `400 validation_failed` |

Mutating admin calls write an audit log line `{actorId, action, runId|version}` (no secret, no query text).

## Removed
Catalog routes `GET /products/search` and `GET /shops/:shopId/products/search` (served here), query parameters `size`, `from`, `priceMin`, `priceMax`, `ratingMin`, response members `hits`, `suggestions`, `source`.

## Route registration
`ProductSearchModule` is imported **before** `CatalogModule` in `apps/core` so `/products/search` is matched before `/products/:id`; the catalog's `RESERVED_PRODUCT_SEGMENTS` entry for `search` stays until S05 removes it (sibling follow-up).
