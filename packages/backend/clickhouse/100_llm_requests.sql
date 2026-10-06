-- SD-42: one row per model call. Answers "p95 time-to-first-token by model", "cache hit ratio",
-- "cost per user / per day", "how often do refusals fall back". Billing never reads this (usage_events does).
CREATE TABLE IF NOT EXISTS llm_requests
(
    event_id            String,
    user_id             String,
    conversation_id     String,
    message_id          String,
    purpose             LowCardinality(String),
    requested_model     LowCardinality(String),
    model               LowCardinality(String),
    ttft_ms             Nullable(UInt32),
    duration_ms         UInt32,
    input_tokens        UInt32,
    output_tokens       UInt32,
    cache_read_tokens   UInt32,
    cache_write_tokens  UInt32,
    cost_micros         UInt64,
    stop_reason         LowCardinality(String),
    tool_calls          UInt8,
    ts                  DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (user_id, ts, event_id)
TTL toDateTime(ts) + INTERVAL 180 DAY;

CREATE TABLE IF NOT EXISTS llm_daily
(
    day                 Date,
    model               LowCardinality(String),
    purpose             LowCardinality(String),
    calls               UInt64,
    input_tokens        UInt64,
    output_tokens       UInt64,
    cache_read_tokens   UInt64,
    cost_micros         UInt64,
    refusals            UInt64
)
ENGINE = SummingMergeTree
ORDER BY (day, model, purpose);

CREATE MATERIALIZED VIEW IF NOT EXISTS llm_daily_mv TO llm_daily AS
SELECT toDate(ts) AS day, model, purpose, count() AS calls, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
       sum(cache_read_tokens) AS cache_read_tokens, sum(cost_micros) AS cost_micros, countIf(stop_reason = 'refusal') AS refusals
FROM llm_requests GROUP BY day, model, purpose;
