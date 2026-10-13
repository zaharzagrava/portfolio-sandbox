-- S25: a root comment row says whether its subtree has more descendants than the embedded first page (set once, never
-- cleared: tombstones keep their position), so a thread page needs no peek read per root.
ALTER TABLE marketplace.comments_by_post ADD more_replies boolean;
