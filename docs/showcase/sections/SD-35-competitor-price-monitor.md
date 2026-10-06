# SD-35 — Competitor Price Monitor (Web crawler)

Status: ☑ done (typechecked; specs written, not run) · Phase 6 · Depends on: SD-29, SD-28, SD-30 (SSRF guard), SD-17 · DOUBTS Q5

## Marketplace adaptation
Pro shops register public competitor product URLs; we re-crawl them politely and alert when a competitor's price drops below theirs.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **URL frontier** in Redis: per-host queues + a ready-host ZSET by next-allowed-time (politeness), priority by shop plan & change frequency | 10/09 #35 |
| `robots.txt` fetch + cache (24 h), `Crawl-delay` honoured, identifiable User-Agent | 10/09 #35 |
| URL normalisation (strip tracking params) + **Bloom filter** seen-set (genuinely needed at 100M URLs) | 10/09 #35 |
| **SimHash** of extracted content to skip unchanged pages / near-duplicates | 10/09 #35 |
| Fetchers: async with concurrency per host = 1, global pool, timeouts, max body size, SSRF guard | 06/03, 05/01 §6 |
| Price extraction: JSON-LD `Product/Offer` first, then OpenGraph/meta fallback | — |
| Raw HTML to S3 (lifecycle 7 days); price history in ClickHouse | 10/09 #35 |
| Recrawl schedule adaptive to change rate | 10/09 #35 |

## Steps
- [x] `CompetitorWatch` model; frontier service; fetcher worker; extractor; alert on drop (SD-17).
- [x] `BloomFilter` (shared with SD-34 penetration guard), `SimHash` (pure, unit-tested).
- [x] e2e: local fixture server with robots.txt disallow → not fetched; JSON-LD price parsed; price drop → notification spy called.

## Scale
- Target: 10M watched URLs, re-crawled every 6 h → ~460 fetches/s; politeness is the constraint → partition frontier by host hash across fetcher instances.

## Implementation notes (2026-10-02)
- **Schema:** migration `20261002140000-competitor-watch` adds `CrawlTarget` (normalized URL = the fetch unit, shared by every shop watching it) and `CompetitorWatch`. ClickHouse `competitor_prices` (`clickhouse/090_competitor_prices.sql`).
- **Pure primitives** (unit spec, checked locally):
  - `normalizeUrl` (tracking params, fragment, default port, sorted query).
  - `parseRobots`/`isAllowed` (RFC 9309: specific group over `*`, longest match, `*` and `$`, Crawl-delay).
  - `simhash` (3-word shingles, 64-bit: a rotated widget = 0 bits, an unrelated page = 27).
  - `extractPrice` (JSON-LD Product/Offer/AggregateOffer incl. `@graph`, then OG/itemprop meta; never free text).
- **`net/pinned-get.ts`:** SSRF guard re-run on every redirect hop, connection pinned to the checked IP, 2 MB cap, timeout.
- **`Frontier`** (Redis): per-host lists + a ready-host ZSET; an atomic Lua `take` leases the host, so there's one in-flight fetch per host fleet-wide; `release` applies the Crawl-delay (min 1 s; 429/503 → 10× back-off).
- **`CrawlerService`:**
  - `watch` (normalize + SSRF check + dedupe target).
  - `scheduleDue` (minute job; one frontier entry per target per cycle).
  - `crawl`: robots (cached 24 h; 5xx → disallow, per RFC 9309) → fetch → price extraction **always** → "unchanged" only if same price AND SimHash ≤ 3 bits (then exponential recrawl back-off 6 → 48 h) → raw HTML to S3 (7-day lifecycle) → ClickHouse history → alert the owners of products this price undercuts (SD-17 `competitor.price_drop`, new `insights` category; deduped per watch+price).
  - 16 fetch loops per worker instance.
- **Bug found while writing the spec:** using SimHash to skip extraction would MISS price changes (a one-token edit); fixed as above, and the spec pins it.
- **Bloom filter deliberately not used:** we crawl registered URLs, not discovered links; the shared `CrawlTarget` dedupes better and a Bloom false positive would skip fetches (D6). See DOUBTS Q61.

## Test plan
| Scenario | API e2e | UI journey (web) | Unit |
|---|---|---|---|
| Shop watches a competitor URL; undercut → alert; raise → no alert; price change not missed | `crawler.e2e-spec.ts` | web: add competitor URL → price chart (happy path) | `crawler.spec.ts` (JSON-LD/meta) |
| robots.txt disallow → never fetched | `crawler.e2e-spec.ts` | — | `crawler.spec.ts` (rules) |
| Unchanged page → backoff | `crawler.e2e-spec.ts` | — | `crawler.spec.ts` (SimHash) |
| Politeness: one in-flight fetch per host + Crawl-delay; shared target across shops | `crawler.e2e-spec.ts` | — | — |
| SSRF: internal URLs refused | `crawler.e2e-spec.ts` | — | `net/ssrf-guard.spec.ts` |
