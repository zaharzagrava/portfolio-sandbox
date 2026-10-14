-- S42: additive columns of the public API request record (data-model.md section 1, "Not stored here").
-- Existing rows read the defaults; nothing the running code selects changes shape.
ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS client_request_id String DEFAULT '';
ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS error_code LowCardinality(String) DEFAULT '';
ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS batch_ops UInt16 DEFAULT 0;
ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS idempotent_replay UInt8 DEFAULT 0;
