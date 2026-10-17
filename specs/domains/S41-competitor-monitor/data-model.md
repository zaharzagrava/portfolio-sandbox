# Data model: S41 — Competitor Price Monitor

Owner of every object below: `domain:seller-insights`. No foreign key leaves the domain (IX.4). Current tables come from migration `20261002140000-competitor-watch.js`; everything marked **new** is added by one expand migration (`lock_timeout`, III.11).

## Postgres

### `CrawlTarget` (one normalised URL, shared by all watchers)

| Column | Type | Note |
|---|---|---|
| id | UUID PK | `uuidv7()` |
| url | TEXT UNIQUE | normalised (FR-017); existing rows re-normalised and merged by the migration |
| host | TEXT | punycode, lower case |
| lastPriceMinor / currency | BIGINT / TEXT null | last observation |
| simhash | TEXT null | 16 hex digits |
| unchangedStreak | INT | reset by any changed page (AS-37) |
| lastStatus | TEXT null | closed vocabulary, research D-02; legacy hyphenated values mapped |
| lastCheckedAt / nextCheckAt | TIMESTAMPTZ | `nextCheckAt` default `now()` |
| **observationNo** | INT default 0 | count of recorded observations; optimistic-concurrency token (AS-42) |
| **evaluatedNo** | INT default 0 | last observation fully evaluated (crash repair, research D-06) |
| **lastObservedAt** | TIMESTAMPTZ null | |
| **noPriceStreak** | INT default 0 | three → 24 h (AS-38) |
| **errorStreak** | INT default 0 | drives the error and `gone` ladders (AS-29) |
| **queuedAt** | TIMESTAMPTZ null | informational; the authoritative mark is the Redis key |
| **retiredAt** | TIMESTAMPTZ null | set when the last watch goes; target purged 30 days later |

Indexes: `(nextCheckAt) WHERE retiredAt IS NULL` (scheduler), `(retiredAt) WHERE retiredAt IS NOT NULL` (purge), existing unique on `url`.

### `CompetitorWatch` (a shop's product linked to a target)

| Column | Type | Note |
|---|---|---|
| id | UUID PK | watch id, also event aggregate id |
| shopId, productId | UUID | plain ids, **FKs to `Shop`/`Product` dropped** |
| targetId | UUID FK → `CrawlTarget` | own table, no cascade needed |
| createdAt | TIMESTAMPTZ | |
| **status** | TEXT `ACTIVE`/`PAUSED` default `ACTIVE` | follows shop status (D-09) |
| **lastEvaluatedObservationNo** | INT default 0 | at-most-once guard per (watch, counter) |
| **lastEvaluatedPriceMinor** | BIGINT null | "lower than the previous evaluation" (FR-025) |

Unique `(productId, targetId)` (existing). New indexes: `(shopId, createdAt DESC, id DESC)` (list keyset), `(shopId, productId)` (per-product limit), `(targetId) WHERE status='ACTIVE'` (evaluation + scheduler).

### `CompetitorShop` — **new**, R3 read model (registry entry `domain:seller-insights` in `db/ownership.ts`)

`shopId UUID PK, plan TEXT NULL, status TEXT NOT NULL, version INT NOT NULL, updatedAt`. Copy of tenancy events; written only by the shop consumer; guarded by `WHERE version < :v`.

### State machines

- **Watch**: `ACTIVE ⇄ PAUSED` (only by shop status: `ACTIVE`→ACTIVE, `SUSPENDED|DELETING`→PAUSED); terminal by deletion (user `DELETE`, product deleted, shop deleted). Transitions are conditional updates (III.7).
- **Target**: `due → queued (Redis mark) → crawled → due(next)`; `retired` when no watch (not scheduled; entries dropped on take); `purged` after 30 days.
- **Observation step**: `read n → history(n+1) → UPDATE … WHERE observationNo = n → batches evaluate`.

## ClickHouse `competitor_prices` (new migration `09x`)

Add `observation_no UInt32`; engine `ReplacingMergeTree`-free: keep `MergeTree ORDER BY (target_id, ts)` and enable `non_replicated_deduplication_window` with an insert dedup token `"<target_id>:<observation_no>"` (a retried insert adds no second row; AS-41). 2-year `TTL` stays. Rows only when price or currency changed (questions: BREAKING).

## Redis (all derived, all with TTL; `{s}` hash-tag shard)

| Key | Content | TTL |
|---|---|---|
| `crawl:{s}:ready` | ZSET host → next-allowed epoch ms | self-healing; rebuilt by the scheduler |
| `crawl:{s}:host:<host>` | LIST of target ids | dropped when empty |
| `crawl:queued:<targetId>` | queue mark, `NX` | 15 min |
| `crawl:robots:<scheme>://<host>:<port>` | rules + delay | 24 h / 1 h / 15 min |
| `crawl:seen` | Bloom bit array | refreshed on write, refilled lazily |
| `crawl:cycle:<minute>` | per-run guard | 2 min |

## Object storage

`crawl/<yyyy-mm-dd>/<host>/<targetId>-<epochMs>.html`, 7-day lifecycle rule on prefix `crawl/`.

## Validation rules (domain, pure)

URL: `https`, no credentials, port 443 only, ≤ 2048 chars, normalised per AS-40. Price: exact decimal → minor units by ISO 4217 exponent, half-up, `0 < p ≤ 10^12`, currency required, ambiguity → no price. Interval: base 6 h; unchanged ladder 12/24/48/48 h; errors 1→24 h doubling; `gone` 12→48 h; ±10 % jitter; floor 1 h.
