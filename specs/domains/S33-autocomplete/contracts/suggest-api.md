# Contract: `GET /suggest` (public, anonymous)

Schemas: `suggestQuerySchema`, `suggestResponseSchema` and the problem schema in `packages/contracts/src/search/suggest.ts`.

**Request**: `q` (string, required, ≤ 100 characters after reduction), `limit` (integer 1–10, default 8). Any other parameter ⇒ `400`.

**200**: `{prefix, suggestions: {text, source: 'query'|'catalog'|'typo'}[], degraded: ('catalog_timeout'|'catalog_unavailable'|'typo_fallback_timeout'|'typo_fallback_unavailable'|'query_index_unavailable')[]}`
- `Cache-Control: public, max-age=60, s-maxage=60` when `degraded` is empty, otherwise `no-store`. No `Set-Cookie`, no credential `Vary`.
- Clients accept unknown `source` values (V.7).

**Errors** (`application/problem+json`: `type, title, status, detail, instance, requestId, code`; `Cache-Control: no-store`): `400 validation_failed` (with `errors[]`), `429 rate_limited` (+ `Retry-After`), `5xx` with generic detail.

**Rate limit**: `discovery.suggest`, 600/min per address, fail open.

**Ports** (`domain/autocomplete-ports.ts`): `QueryIndexSnapshotStore{put,get,list,delete}`, `SnapshotPointer{read,compareAndSet,forceSet}`, `SearchLogReader{eligibleQueries(params, signal)}`, `CatalogTitleSource{suggestTitles,suggestTitlesFuzzy}(prefix,size,signal)`, `Clock{now}`.

**Job**: `search.build-autocomplete`, cron `7 * * * *`, payload `{}`, `leaseMs: 600_000`, `maxRuntimeMs: 600_000`, concurrency 1.

**Metrics** (`autocomplete_` prefix, bounded labels, never query text): requests by status, degraded by reason, source duration by source, circuit state, builds by outcome, snapshot age, snapshot version, snapshot load failures by reason.
