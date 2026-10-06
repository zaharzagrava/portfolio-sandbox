-- SD-24 usage metering. Raw usage events (API calls, LLM tokens) arrive via
-- Kafka `usage.events`. ReplacingMergeTree(event_id ordering) collapses
-- duplicates (producer retries) at merge time; billing queries use FINAL so
-- they're exact even before merges. `ingested_at` lets the invoice run detect
-- LATE events for an already-invoiced period (billed as adjustments next time).
CREATE TABLE IF NOT EXISTS usage_events
(
    event_id     String,
    subject_id   String,
    metric       LowCardinality(String),
    quantity     UInt64,
    ts           DateTime64(3, 'UTC'),
    ingested_at  DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (subject_id, metric, event_id);

-- Approximate hourly rollup for dashboards (may include not-yet-merged duplicates; billing never reads it).
CREATE TABLE IF NOT EXISTS usage_hourly
(
    subject_id String,
    metric     LowCardinality(String),
    hour       DateTime('UTC'),
    quantity   UInt64
)
ENGINE = SummingMergeTree
ORDER BY (subject_id, metric, hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS usage_hourly_mv TO usage_hourly AS
SELECT subject_id, metric, toStartOfHour(ts) AS hour, sum(quantity) AS quantity
FROM usage_events
GROUP BY subject_id, metric, hour;
