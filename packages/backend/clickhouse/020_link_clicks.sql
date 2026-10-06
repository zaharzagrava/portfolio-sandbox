-- SD-08 click analytics (never written in the redirect path; arrives via Kafka `links.events`).
CREATE TABLE IF NOT EXISTS link_clicks
(
    click_id    String,
    code        String,
    ts          DateTime64(3, 'UTC'),
    country     LowCardinality(String),
    referer     String,
    via_edge    UInt8
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (code, ts, click_id)
TTL toDateTime(ts) + INTERVAL 13 MONTH;

CREATE TABLE IF NOT EXISTS link_clicks_minute
(
    code   String,
    minute DateTime('UTC'),
    clicks UInt64
)
ENGINE = SummingMergeTree
ORDER BY (code, minute);

CREATE MATERIALIZED VIEW IF NOT EXISTS link_clicks_minute_mv TO link_clicks_minute AS
SELECT code, toStartOfMinute(ts) AS minute, count() AS clicks FROM link_clicks GROUP BY code, minute;
