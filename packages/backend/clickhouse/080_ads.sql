-- SD-32 sponsored-listing clicks. Two paths (lambda architecture):
--   speed: ads.clicks → transactional aggregator (exactly-once) → ads.click-aggregates → ad_click_minute → hourly billing
--   batch: ads.clicks → ad_clicks_raw (deduped by click_id) → daily reconciliation recomputes and corrects billing

CREATE TABLE IF NOT EXISTS ad_clicks_raw
(
    click_id     String,
    campaign_id  String,
    shop_id      String,
    ts           DateTime64(3, 'UTC'),
    ip_hash      String,
    valid        UInt8
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (campaign_id, toStartOfHour(ts), click_id)
TTL toDateTime(ts) + INTERVAL 400 DAY;   -- billing evidence

-- One row per (campaign, minute, source partition, first offset of the batch): a re-delivered
-- aggregate batch has the same identity and REPLACES its row - idempotent upsert.
CREATE TABLE IF NOT EXISTS ad_click_minute
(
    campaign_id       String,
    minute            DateTime('UTC'),
    source_partition  UInt16,
    first_offset      UInt64,
    clicks            UInt64,
    invalid           UInt64
)
ENGINE = ReplacingMergeTree
ORDER BY (campaign_id, minute, source_partition, first_offset);

CREATE TABLE IF NOT EXISTS ad_clicks_queue
(
    click_id String, campaign_id String, shop_id String, ts DateTime64(3, 'UTC'), ip_hash String, valid UInt8
)
ENGINE = Kafka
SETTINGS kafka_broker_list = 'kafka:29092', kafka_topic_list = 'ads.clicks', kafka_group_name = 'clickhouse-ad-clicks', kafka_format = 'JSONEachRow';

CREATE MATERIALIZED VIEW IF NOT EXISTS ad_clicks_raw_mv TO ad_clicks_raw AS SELECT * FROM ad_clicks_queue;

-- Aggregates are produced inside Kafka transactions: only read COMMITTED ones.
CREATE TABLE IF NOT EXISTS ad_click_aggregates_queue
(
    campaign_id String, minute DateTime('UTC'), source_partition UInt16, first_offset UInt64, clicks UInt64, invalid UInt64
)
ENGINE = Kafka
SETTINGS kafka_broker_list = 'kafka:29092', kafka_topic_list = 'ads.click-aggregates', kafka_group_name = 'clickhouse-ad-aggregates',
         kafka_format = 'JSONEachRow'; -- read_committed: server-level librdkafka config (infra/docker/clickhouse/kafka.xml, Q58)

CREATE MATERIALIZED VIEW IF NOT EXISTS ad_click_minute_mv TO ad_click_minute AS SELECT * FROM ad_click_aggregates_queue;
