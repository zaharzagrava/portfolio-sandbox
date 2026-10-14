-- S39 analytics store v2. Identity of an event is `event_id` ALONE, across names, days and receive times, and the first
-- received copy is the one every read uses. A ReplacingMergeTree cannot do that: the partition is the EVENT day, so a copy whose
-- `ts` was re-clamped lives in another partition and never merges with the first, and `(received_at)` as a version keeps
-- the LATEST copy. `analytics_event_log` is a plain MergeTree and every read collapses with
-- `argMin(col, tuple(received_at, ts, name)) ... GROUP BY event_id` (correct before, during and after any merge).
-- Expand/contract: `analytics_events` is frozen (nothing writes it after this file) and dropped by a later file, no earlier
-- than two weeks after the first deploy of this one. The statements are idempotent and self-contained (a stack that never
-- ran 070 gets the same objects).

CREATE TABLE IF NOT EXISTS analytics_events
(
    event_id      UUID,
    name          LowCardinality(String),
    anonymous_id  String,
    user_id       String,
    ts            DateTime64(3, 'UTC'),
    received_at   DateTime64(3, 'UTC'),
    country       LowCardinality(String),
    platform      LowCardinality(String),
    page          String,
    props         Map(String, String)
)
ENGINE = ReplacingMergeTree(received_at)
PARTITION BY toYYYYMMDD(ts)
ORDER BY (name, toDate(ts), event_id)
TTL toDateTime(ts) + INTERVAL 400 DAY;

CREATE TABLE IF NOT EXISTS analytics_event_log
(
    event_id      UUID,
    name          LowCardinality(String),
    anonymous_id  String,
    user_id       String,
    ts            DateTime64(3, 'UTC'),
    received_at   DateTime64(3, 'UTC'),
    country       LowCardinality(String),
    platform      LowCardinality(String),
    page          String,
    props         Map(String, String),
    ingested_at   DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (toDate(ts), name, event_id)
TTL toDateTime(ts) + INTERVAL 400 DAY;

CREATE TABLE IF NOT EXISTS analytics_events_queue
(
    event_id      UUID,
    name          String,
    anonymous_id  String,
    user_id       String,
    ts            DateTime64(3, 'UTC'),
    received_at   DateTime64(3, 'UTC'),
    country       String,
    platform      String,
    page          String,
    props         Map(String, String)
)
ENGINE = Kafka
SETTINGS kafka_broker_list = 'kafka:29092',
         kafka_topic_list = 'analytics.events',
         kafka_group_name = 'clickhouse-analytics',
         kafka_format = 'JSONEachRow',
         kafka_num_consumers = 4,
         kafka_handle_error_mode = 'stream';

CREATE TABLE IF NOT EXISTS analytics_events_errors
(
    raw        String,
    error      String,
    topic      String,
    partition  UInt64,
    offset     UInt64,
    at         DateTime DEFAULT now()
)
ENGINE = MergeTree ORDER BY at TTL at + INTERVAL 14 DAY;

DROP VIEW IF EXISTS analytics_events_mv;

CREATE MATERIALIZED VIEW analytics_events_mv TO analytics_event_log AS
SELECT event_id, name, anonymous_id, user_id, ts, received_at, country, platform, page, props
FROM analytics_events_queue WHERE length(_error) = 0;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics_events_errors_mv TO analytics_events_errors AS
SELECT _raw_message AS raw, _error AS error, _topic AS topic, _partition AS partition, _offset AS offset
FROM analytics_events_queue WHERE length(_error) > 0;

INSERT INTO analytics_event_log (event_id, name, anonymous_id, user_id, ts, received_at, country, platform, page, props)
SELECT event_id, name, anonymous_id, user_id, ts, received_at, country, platform, page, props
FROM analytics_events
WHERE event_id NOT IN (SELECT event_id FROM analytics_event_log);
