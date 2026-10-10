-- S32: search measurement columns. The 90-day TTL of search_queries and search_clicks is declared in 030_search_queries.sql.
-- Rows written before this migration keep the defaults. Click deduplication is by (search_id, product_id, position, event_id).
ALTER TABLE search_queries ADD COLUMN IF NOT EXISTS search_id String DEFAULT '';
ALTER TABLE search_queries ADD COLUMN IF NOT EXISTS mode LowCardinality(String) DEFAULT '';
ALTER TABLE search_queries ADD COLUMN IF NOT EXISTS degraded Array(String) DEFAULT [];
ALTER TABLE search_queries ADD COLUMN IF NOT EXISTS surface LowCardinality(String) DEFAULT '';
ALTER TABLE search_queries ADD COLUMN IF NOT EXISTS filters Array(String) DEFAULT [];
ALTER TABLE search_clicks ADD COLUMN IF NOT EXISTS search_id String DEFAULT '';
