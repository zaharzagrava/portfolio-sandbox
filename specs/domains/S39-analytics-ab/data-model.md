# Data model: S39 — Analytics ingestion and A/B testing

Owner of everything below: `domain:experimentation` (IX.3). No other domain reads these stores; the topic is the only outward path (R3).

## PostgreSQL

### `Experiment` (existing, extended by an expand-only migration, see research R-16)

| Column | Type | Rule |
|---|---|---|
| `key` | text PK | `^[a-z0-9][a-z0-9-]{1,63}$` (existing check), immutable |
| `description` | text | ≤ 500, may be empty, default `''` |
| `owner` | text NOT NULL | 1–100; backfilled `unknown` |
| `unit` | text NOT NULL | `user` \| `visitor`, default `user` |
| `status` | text NOT NULL | `DRAFT` \| `RUNNING` \| `STOPPED` (API shows lowercase) |
| `variants` | jsonb NOT NULL | 2–10 items `{key: ^[a-z0-9][a-z0-9_-]{0,31}$, weight: integer ≥ 1}`, weights sum 10,000, first is control |
| `layer` | text | `^[a-z0-9][a-z0-9-]{1,31}$` |
| `layerFrom`, `layerTo` | integer | `0 ≤ layerFrom < layerTo ≤ 10,000`, `layerTo` exclusive (existing checks) |
| `metric` | text | `page_view, product_view, search, add_to_cart, checkout_step, click, video_view, purchase` |
| `version` | integer NOT NULL | starts at 1, +1 per applied change |
| `startedAt`, `stoppedAt` | timestamptz null | set once by `start` / `stop` |
| `startedBy`, `stoppedBy` | text null | admin user id (cross-domain reference by id, no FK) |
| `createdAt`, `updatedAt` | timestamptz NOT NULL | |

Constraints kept: `Experiment_layer_no_overlap` (`EXCLUDE USING gist (layer WITH =, int4range(layerFrom, layerTo) WITH &&) WHERE status = 'RUNNING'`); added: variant count check. Index for the keyset list: `(createdAt DESC, key DESC)`.

### `ExperimentAudit` (new, append-only, registered `domain:experimentation`)

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | |
| `experimentKey` | text NOT NULL | no FK (history outlives nothing, but audit tables never block) |
| `action` | text NOT NULL | `create` \| `update` \| `start` \| `stop` |
| `actorId` | text NOT NULL | the admin's user id |
| `requestId` | text null | from request context |
| `before` | jsonb null | null on create |
| `after` | jsonb NOT NULL | the stored definition incl. status, version |
| `at` | timestamptz NOT NULL | injected clock |

Index `(experimentKey, at DESC, id DESC)` for the history cursor. One row per applied change; none for a no-op.

### State machine (FR-022, III.7)

```text
draft ──start──▶ running ──stop──▶ stopped        (terminal)
  │  ▲ save (any field)   │ save (description, owner only)
  └──┘                    └──┘
repeat start on running, repeat stop on stopped → no-op (200, no row, no history)
start on stopped, stop on draft → 409 illegal_transition
save changing variants|weights|layer|range|unit|metric on running|stopped → 409 experiment_immutable
```

Write-order of decisions in `decide(current, command)`: unknown key (update with `expectedVersion > 0`) → `404 not_found`; equal definition → no-op; stale `expectedVersion` → `409 version_conflict` (`currentVersion` in the body); immutability → `409 experiment_immutable`; semantic validation → `422`. A switch over `status` ends in `assertNever`.

## ClickHouse

### `analytics_event_log` (new, `072_analytics_dedupe.sql`)

```text
event_id UUID, name LowCardinality(String), anonymous_id String, user_id String,
ts DateTime64(3,'UTC'), received_at DateTime64(3,'UTC'),
country LowCardinality(String), platform LowCardinality(String), page String,
props Map(String,String), ingested_at DateTime64(3,'UTC') DEFAULT now64(3)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)                -- event day: late events land in their own day (AS-16)
ORDER BY (toDate(ts), name, event_id)
TTL toDateTime(ts) + INTERVAL 400 DAY
```

Identity is `event_id` only. Reads never touch the raw table directly; the repository always uses the collapse:

```text
SELECT event_id,
       argMin(name, k) AS name, argMin(anonymous_id, k) AS anonymous_id, argMin(user_id, k) AS user_id,
       argMin(ts, k) AS ts, argMin(props, k) AS props
FROM analytics_event_log
WHERE event_id IN (<candidate ids, research R-2>)
GROUP BY event_id
-- k = tuple(received_at, ts, name)
```

### Other tables

| Table | Change |
|---|---|
| `analytics_events_queue` | none (Kafka engine, group `clickhouse-analytics`, topic `analytics.events`, `kafka_handle_error_mode='stream'`) |
| `analytics_events_mv` | recreated `TO analytics_event_log` |
| `analytics_events_errors` | none (`raw, error, topic, partition, offset, at`, TTL 14 d); its MV unchanged; the purchase projector's dead letters go to the S53 dead-letter store, not here |
| `analytics_events` | frozen, kept one release, then dropped by a later file (expand/contract) |

Results query shape (one statement, parameterised, read-committed, `max_execution_time = 10`): per-unit first exposure (`argMin(variant, ts)`, `min(ts)`, `uniqExact(variant)` for crossover) restricted to `startedAt ≤ ts ≤ windowEnd`; unit = `user_id` for `unit = user` (rows with empty `user_id` counted as `unattributable`) or `anonymous_id` for `visitor`; conversion = a collapsed row of the metric name with the same unit and `first_exposure ≤ ts ≤ windowEnd`. Output: `variant, exposures, conversions` rows plus scalar `crossoverUnits`, `unknownVariant`, `unattributable`.

## Message on the topic (`analytics.events`, key `anonymous_id`)

Stored event: `{event_id, name, anonymous_id, user_id, ts, received_at, country, platform, page, props}`; `ts`, `received_at` `YYYY-MM-DD HH:mm:ss.SSS` UTC; every prop value a string. Server events (`purchase`) are written by the projector straight into the store with `anonymous_id: ""` and `platform: "server"`; they never travel on this topic.

## Redis / memory

| Key | Content | TTL |
|---|---|---|
| `experiments:running` | JSON array of running definitions (key, unit, variants, layer, range) | 30 s, deleted on every applied write |
| per-instance memory | the same array | 10 s |

## Derived (never stored)

- **Assignment**: recomputed from the hash (FR-024).
- **Readout**: computed per request (`asOf` = clock time of the query).

## Validation rule index

| Rule | Where |
|---|---|
| Client event fields, clock, exposure shape, codes | `packages/contracts/src/analytics/ingest-rules.ts` (R-3) |
| Experiment shape | `experimentWriteSchema` (zod, strict) |
| Experiment meaning (10 codes) | `domain/experiment-definition.ts` |
| Transition and immutability | `domain/experiment-lifecycle.ts` |
