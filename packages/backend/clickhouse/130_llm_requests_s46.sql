-- S46 (data-model.md, "Model call record"): additive columns of `llm_requests` for the `llm.call_completed` v1 fields
-- that are new (subject, metric, billable tokens, outcome, estimate flag). Existing rows read the defaults; de-duplication
-- by event_id (ReplacingMergeTree, event_id derived from call_id) stays as it was. `purpose` already exists.
ALTER TABLE llm_requests ADD COLUMN IF NOT EXISTS call_id String DEFAULT '';
ALTER TABLE llm_requests ADD COLUMN IF NOT EXISTS subject_id String DEFAULT '';
ALTER TABLE llm_requests ADD COLUMN IF NOT EXISTS metric LowCardinality(String) DEFAULT '';
ALTER TABLE llm_requests ADD COLUMN IF NOT EXISTS billable_tokens UInt64 DEFAULT 0;
ALTER TABLE llm_requests ADD COLUMN IF NOT EXISTS outcome LowCardinality(String) DEFAULT '';
ALTER TABLE llm_requests ADD COLUMN IF NOT EXISTS usage_estimated UInt8 DEFAULT 0;
