-- S28 inbox, expand step 1. `arrived_at` is when the item reached the inbox (the mark-all watermark is compared with
-- it, not with the event time). Nullable: a row without it counts as arrived at its own creation time. One column per
-- file so a failed run can be repeated (ALTER ... ADD has no IF NOT EXISTS here).
ALTER TABLE marketplace.inbox_by_user ADD arrived_at timestamp;
