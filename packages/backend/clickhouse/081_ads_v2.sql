-- S36 sponsored listings, step 2 of the click pipeline (specs/domains/S36-sponsored-listings/data-model.md).
-- The Kafka-engine queue tables and their materialised views of 080_ads.sql are dropped in this same file: left in
-- place they would keep consuming `ads.clicks` with a shape they no longer know. The app now writes both tables itself
-- (`ads-click-log-writer`, `ads-aggregate-writer`) with insert deduplication tokens, and reads `ads.click-aggregates`
-- with isolation read_committed. `ad_clicks_raw` and `ad_click_minute` stay one release, no longer written.

DROP TABLE IF EXISTS ad_clicks_raw_mv;
DROP TABLE IF EXISTS ad_click_minute_mv;
DROP TABLE IF EXISTS ad_clicks_queue;
DROP TABLE IF EXISTS ad_click_aggregates_queue;

-- Raw log: NOT a ReplacingMergeTree. A merge that keeps "the latest" row per click id is the defect (G25): the first
-- recorded verdict must win, so rows are kept and the reader picks `argMin(valid, (received_at, ingested_at))`.
-- Raw clicks are kept 400 days as billing evidence (FR-039).
CREATE TABLE IF NOT EXISTS ad_clicks_log
(
    click_id       String,
    campaign_id    String,
    shop_id        String,
    product_id     String,
    received_at    DateTime64(3, 'UTC'),
    ip_hash        String,
    viewer_hash    String,
    valid          UInt8,
    invalid_reason LowCardinality(Nullable(String)),
    ingested_at    DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(received_at)
ORDER BY (toStartOfHour(received_at), campaign_id, click_id)
TTL toDateTime(received_at) + INTERVAL 400 DAY
SETTINGS non_replicated_deduplication_window = 1000;

-- One row per (campaign, minute, source partition, first offset of the batch): a re-delivered aggregate batch has the
-- same identity and replaces its row; the per-minute total is the sum of the salted partials (read with FINAL).
CREATE TABLE IF NOT EXISTS ad_click_minute_v2
(
    campaign_id       String,
    minute            DateTime('UTC'),
    source_partition  UInt16,
    first_offset      UInt64,
    clicks            UInt64,
    invalid           UInt64
)
ENGINE = ReplacingMergeTree
ORDER BY (campaign_id, minute, source_partition, first_offset)
SETTINGS non_replicated_deduplication_window = 1000;

-- A table created before the window setting existed gets it too: an insert carrying a deduplication token is then
-- dropped by the server when the same block arrives again (a redelivered batch).
ALTER TABLE ad_clicks_log MODIFY SETTING non_replicated_deduplication_window = 1000;
ALTER TABLE ad_click_minute_v2 MODIFY SETTING non_replicated_deduplication_window = 1000;
