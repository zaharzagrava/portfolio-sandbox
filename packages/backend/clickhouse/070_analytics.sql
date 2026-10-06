-- SD-31 product analytics. Client events never touch the API: edge (/collect) → Kafka `analytics.events`
-- → ClickHouse Kafka engine → materialized view. 200k events/s is ClickHouse's own consumer's job, not Node's.

CREATE TABLE IF NOT EXISTS analytics_events
(
    event_id      UUID,
    name          LowCardinality(String),
    anonymous_id  String,
    user_id       String,
    ts            DateTime64(3, 'UTC'),        -- event time (client clock, clamped at ingest)
    received_at   DateTime64(3, 'UTC'),        -- ingest time
    country       LowCardinality(String),
    platform      LowCardinality(String),
    page          String,
    props         Map(String, String)
)
-- Client retries/sendBeacon duplicates share event_id → collapsed at merge time; queries use FINAL or argMax.
ENGINE = ReplacingMergeTree(received_at)
PARTITION BY toYYYYMMDD(ts)                    -- by EVENT time: late events land in their own day
ORDER BY (name, toDate(ts), event_id)
TTL toDateTime(ts) + INTERVAL 400 DAY;

-- Kafka engine: ClickHouse is the consumer group. Malformed rows don't stop the stream: they go to the
-- error table (kafka_handle_error_mode = 'stream' exposes _raw_message/_error) - our DLQ.
-- In AWS the broker list / SASL settings come from a named collection (Confluent Cloud), not this literal.
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

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics_events_mv TO analytics_events AS
SELECT event_id, name, anonymous_id, user_id, ts, received_at, country, platform, page, props
FROM analytics_events_queue WHERE length(_error) = 0;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics_events_errors_mv TO analytics_events_errors AS
SELECT _raw_message AS raw, _error AS error, _topic AS topic, _partition AS partition, _offset AS offset
FROM analytics_events_queue WHERE length(_error) > 0;
