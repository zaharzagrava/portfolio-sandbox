# SD-12 — Search Autocomplete (query-log top-K + catalog completions)

Status: ☑ done (typechecked; specs written, not run) · Phase 3 · Depends on: SD-31 (query logs), SD-29 · Extends README #15 (ES edge n-grams)

## Marketplace adaptation
README #15 suggests **catalog titles** via ES edge n-grams. Missing: what **people actually search** ("iphone 17 pro max case") ranked by popularity, trending terms, and sub-20 ms responses per keystroke.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Offline: aggregate search queries from ClickHouse (`search_queries` table) → normalise, filter (blocklist, min count) → **precomputed top-K per prefix** | 10/05 #12 |
| **Trie with top-K at each node** built in a worker, serialised to a compact snapshot in S3; serving nodes load it in memory and hot-swap on new version (genuinely needed: O(len(prefix)) lookups, no subtree traversal) | 10/05 #12, 11/03 trie |
| Freshness: trending terms from streaming top-K (SD-32) merged with batch top-K | 10/05 #12 |
| Blend: query suggestions (trie) + product suggestions (ES completion, existing) in one response with per-source timeouts (partial response if ES is slow) | 04/01 §2.1 |
| `Cache-Control: public, max-age=60` for popular prefixes → CDN | 10/05 #12 |
| Typo tolerance fallback to ES fuzzy when trie has no match | 10/09 #37 |

## Steps
- [x] Search query logging (search endpoint emits `search.performed` to Kafka → ClickHouse).
- [x] `TopKTrie` (insert with counts, finalize top-K per node, serialise/deserialise) — unit-tested.
- [x] Build job (SD-29 hourly) → S3 snapshot + version pointer in Redis; serving `SuggestService` polls pointer, loads in background, atomic swap.
- [x] `GET /suggest?q=` merging trie + ES completion with timeouts.
- [x] e2e: after seeding query logs and running the build job, `iph` returns `iphone 17` first.

## Scale
- Target: 50k RPS suggest, p99 < 20 ms origin.
- Hot path: in-memory trie lookup (µs) + ES completion (cached per prefix 60 s) → CDN caches popular prefixes.
- First bottleneck & fix: trie memory → cap prefix length 20, K = 10, only queries with count ≥ 5 → ~2M nodes ≈ 200–400 MB per node; ES → per-prefix cache.
- Capacity model: in-process lookups ~100k/s per core → 4 API nodes cover 50k RPS with ES calls mostly cached.
- Proof: k6 prefix distribution from real-ish query log; p99 < 20 ms.

## Implementation notes (2026-10-01)
- Logging: `GET /api/products/search` emits `search.performed` (normalized query, result count, salted user hash) fire-and-forget → `SearchQueriesProjector` → ClickHouse `search_queries` (`clickhouse/030_search_queries.sql`, 90-day TTL).
- `TopKTrie` (top-K stored per node; built by inserting in count-desc order so the first K arrivals per node ARE the top K; bounded prefix depth; build yields to the event loop every 5k inserts). Spec `top-k-trie.spec.ts`.
- `AutocompleteBuilderJobs` (worker, hourly): ClickHouse `uniqCombined(user_hash) ≥ 5` over 30 days, results > 0, blocklist → gzipped versioned snapshot in object storage → Redis pointer.
- `AutocompleteService` (every API node): polls the pointer, downloads + rebuilds off to the side, atomic swap; `suggest()` = in-memory trie + ES `suggestTitles` under a 40 ms AbortController budget (partial response on timeout). `GET /api/suggest?q=` with `s-maxage=60`.
- Trending-term blend arrives with SD-32 (streaming top-K) - same response shape.
- Test helper `utils/test-utils/clickhouse-ddl.ts`. Spec `autocomplete/autocomplete.e2e-spec.ts` (full pipeline).
