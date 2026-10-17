-- S41: the observation counter that makes a history insert idempotent. The insert dedup token is
-- "<target_id>:<observation_no>"; a retried insert (same block, same token) adds no second row, see
-- ClickHouseObservationHistory. The 2-year TTL of 090 stays.
ALTER TABLE competitor_prices ADD COLUMN IF NOT EXISTS observation_no UInt32 DEFAULT 0;
ALTER TABLE competitor_prices MODIFY SETTING non_replicated_deduplication_window = 1000;
