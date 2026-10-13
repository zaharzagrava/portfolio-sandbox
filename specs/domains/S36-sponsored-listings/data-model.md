# Data model: S36 sponsored listings

Owner of every store below: domain `marketing` (ads half). Money is integer minor units, currency `EUR`. Hours and days are UTC. No table has a foreign key to another owner's table (AS-80); cross-domain references are plain UUID columns. Migrations are expand-first (`lock_timeout` set, `IF NOT EXISTS`), each in its own step; the cross-owner foreign keys are dropped by their own step.

## PostgreSQL

### `AdCampaign` (existing; expanded)

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | `uuidv7()` default |
| `shopId` | uuid | no FK (dropped); every lookup has it in the predicate |
| `productId` | uuid | no FK (dropped) |
| `category` | text | copied from the product at creation |
| `cpcMinor` | integer | new; `CHECK 1..10000`; backfilled from `cpcCents`; the old column stays readable until the contract step |
| `dailyBudgetMinor` | integer | new; `CHECK 100..10000000 AND >= cpcMinor`; backfilled from `dailyBudgetCents` |
| `currency` | text | new, `'EUR'`, `CHECK = 'EUR'` |
| `status` | text | `CHECK IN ('ACTIVE','PAUSED','ENDED')` (the old check allowed two values: replaced) |
| `statusReason` | text null | `'seller' \| 'product_unavailable'`, `NULL` for a fresh `ACTIVE` campaign |
| `campaignVersion` | integer | new; starts at 1, `+1` on every transition |
| `createdAt`, `updatedAt` | timestamptz | `updatedAt` new |

Indexes: `AdCampaign_open_product_uq UNIQUE ("productId") WHERE status <> 'ENDED'` (AS-06); `AdCampaign_shop_list_idx ("shopId", "createdAt" DESC, id DESC)` (AS-12); `AdCampaign_serve_idx ("category", "cpcMinor" DESC, id) WHERE status = 'ACTIVE'` (replaces `AdCampaign_active_idx`, which stays until contract). Existing rows: the migration maps `cpcCents → cpcMinor` and `dailyBudgetCents → dailyBudgetMinor` once; rows that violate the new checks (budget < CPC) are set to `dailyBudgetMinor = cpcMinor` and logged by the migration (none expected in a sandbox).

### `AdCampaignHistory` (new)
`id uuid PK`, `campaignId uuid REFERENCES AdCampaign(id)` (internal FK), `actorId uuid null` (member or `NULL` for system), `fromStatus text null`, `toStatus text`, `reason text`, `campaignVersion int`, `createdAt timestamptz`. Written in the same transaction as the campaign row. `UNIQUE (campaignId, campaignVersion)`.

### `AdProductSponsorship` (new)
`productId uuid PK`, `shopId uuid`, `sponsored boolean`, `sponsorshipVersion integer`, `updatedAt`. Updated only when the value changes: `UPDATE … SET sponsored = :v, sponsorshipVersion = sponsorshipVersion + 1 WHERE productId = :p AND sponsored <> :v` (first row: `INSERT` with version 1 when the first campaign for a product is created).

### `AdShopQuota` (new)
`shopId uuid PK`, `openCount integer CHECK (openCount BETWEEN 0 AND 50)`. Incremented on create (conditional upsert, `WHERE openCount < 50`), decremented when a campaign ends.

### `AdProductSnapshot` (new, R3 read model)
`productId uuid PK`, `shopId uuid`, `title text`, `category text`, `priceMinor integer`, `currency text`, `inStock boolean`, `status text`, `isSandbox boolean`, `productVersion integer`, `updatedAt`. Written by version-guarded upsert (`WHERE existing.productVersion < incoming`); a delete writes `status = 'DELETED'`. Rebuildable by replaying `products.events`. Maximum staleness 60 s at p99.

### `AdShopSnapshot` (new, R3 read model)
`shopId uuid PK`, `status text`, `offboarding boolean`, `deleted boolean`, `shopVersion integer`, `updatedAt`. Same guard. Served only when `status = 'ACTIVE' AND NOT offboarding AND NOT deleted`.

### `AdBillingRun` (existing; expanded)

| Column | Type | Rules |
|---|---|---|
| `campaignId`, `hour` | PK | one run per campaign-hour; internal FK to `AdCampaign` stays |
| `state` | text | new; `PENDING \| CHARGED` (existing rows → `CHARGED`) |
| `source` | text | new; `stream \| reconciliation` (existing → `stream`) |
| `clicks` | integer | valid clicks of the hour (aggregates or exact) |
| `billableClicks`, `cappedClicks` | integer | new; `billable + capped = clicks` |
| `amountMinor` | bigint | new; backfilled from `amountCents`; frozen at insert, never updated |
| `ledgerReference` | text | new; `ad:<campaignId>:<YYYY-MM-DDTHH>` |
| `journalId` | uuid null | was `NOT NULL`; null for a zero-amount run and while `PENDING`; holds the ledger's deterministic journal id |
| `createdAt`, `chargedAt` | timestamptz | `chargedAt` new |
| `reconciledClicks`, `adjustmentJournalId` | | legacy columns, no longer read or written; dropped in the contract step |

`CHECK (state = 'CHARGED' OR amountMinor >= 0)`; `UNIQUE (ledgerReference)`.

### `AdBillingAdjustment` (new)
`campaignId uuid`, `hour timestamptz`, `sequence integer`, `deltaClicks integer`, `deltaMinor bigint` (≠ 0), `ledgerReference text UNIQUE` (`ad-adj:<campaignId>:<YYYY-MM-DDTHH>:<sequence>`), `state text` (`PENDING \| POSTED`), `journalId uuid null`, `reconciliationRunId uuid`, `createdAt`, `postedAt timestamptz null`. PK `(campaignId, hour, sequence)`, internal FK `(campaignId, hour) → AdBillingRun`. Never updated except `PENDING → POSTED`.

### `AdReconciliationRun` (new)
`id uuid PK`, `day date`, `status text` (`RUNNING \| COMPLETED \| FAILED`), `reason text null` (`source_unavailable`, `abandoned`), `hoursChecked int`, `hoursAdjusted int`, `netDeltaMinor bigint`, `driftRatio numeric(8,6) null`, `startedAt`, `finishedAt null`. `UNIQUE (day) WHERE status = 'RUNNING'` (AS-63). A `COMPLETED` day is closed: its rows are read-only; later corrections are `AdBillingAdjustment` rows dated by `postedAt`.

### State machines

Campaign: `ACTIVE → PAUSED (seller | product_unavailable)`, `PAUSED → ACTIVE (seller resume; refused while product unavailable or shop inactive)`, `ACTIVE|PAUSED → ENDED (terminal)`. Sponsored value = `status = 'ACTIVE'`.
Billing run: `PENDING → CHARGED` (conditional update). Adjustment: `PENDING → POSTED`. Reconciliation run: `RUNNING → COMPLETED | FAILED`.

## Redis (derived; every key has a TTL)

| Key | Value | TTL | Owner use |
|---|---|---|---|
| `adclick:<impressionId>` | `1` | 2,100 s (token 1,800 s + 300 s) | dedupe marker, `SET NX` |
| `adspam:ip:<ipHash>:<yyyyMMddHHmm>` | integer | 120 s | address burst counter |
| `adspam:rc:<ipHash>:<campaignId>:<yyyyMMddHH>` | integer | 7,200 s | repeat clicker, address |
| `adspam:rv:<viewerHash>:<campaignId>:<yyyyMMddHH>` | integer | 7,200 s | repeat clicker, viewer |
| `adspend:{<campaignId>}:<YYYY-MM-DD>` | integer (counted clicks) | 172,800 s | serving pacing hint |

The old `adclick:ip:*` keys are left to expire.

## Kafka topics (owner `marketing`)

| Topic | Key | Value | Notes |
|---|---|---|---|
| `marketing.events` | `campaignId` / `productId` | event envelope | outbox; `contracts/events.md` |
| `ads.clicks` | `campaignId#0..9` | `adClickRecord` (snake_case) | idempotent producer; 64 partitions in production (SC-008); 10 in the test stack |
| `ads.click-aggregates` | `campaignId` | `minuteAggregate` | written only inside the aggregator's transaction; read `read_committed` |
| `ads.clicks.dlq` | click key | original bytes + header `reason` | poison messages, written inside the aggregator's transaction |

## ClickHouse (owner `marketing`)

- `ad_clicks_log` (new, `MergeTree`, `PARTITION BY toYYYYMMDD(received_at)`, `ORDER BY (toStartOfHour(received_at), campaign_id, click_id)`, `TTL received_at + 400 DAY`): `click_id String, campaign_id String, shop_id String, product_id String, received_at DateTime64(3,'UTC'), ip_hash String, viewer_hash String, valid UInt8, invalid_reason LowCardinality(Nullable(String)), ingested_at DateTime64(3,'UTC') DEFAULT now64(3)`. Not `ReplacingMergeTree`: the first recorded verdict is chosen at read time (`argMin(valid, (received_at, ingested_at)) … GROUP BY click_id`).
- `ad_click_minute_v2` (new, `ReplacingMergeTree`): `(campaign_id, minute, source_partition, first_offset, clicks, invalid)`, `ORDER BY (campaign_id, minute, source_partition, first_offset)`; read with `FINAL`; per-minute total sums the partials.
- Dropped in `081_ads_v2.sql` (own step): `ad_clicks_queue`, `ad_clicks_raw_mv`, `ad_click_aggregates_queue`, `ad_click_minute_mv`. Kept for one release, no longer written: `ad_clicks_raw`, `ad_click_minute`.

## Click token claims (not stored)

`{i: impressionId, c: campaignId, s: shopId, p: productId, e: expiry epoch ms, v: viewer hash}` + header key ID. No user id, anonymous id or address; no price.

## Validation rules (single source: `packages/contracts/src/marketing/ads.ts`)

`cpcMinor` int 1–10000; `dailyBudgetMinor` int 100–10000000 and ≥ `cpcMinor`; `productId` uuid; request strict (unknown keys → `validation_failed`); `category` query `^[a-z0-9-]{1,40}$` or `all`; `limit` int 1–3 for slots, 1–100 for lists; statement range ≤ 92 days, `from < to`.
