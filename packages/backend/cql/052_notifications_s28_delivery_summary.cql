-- S28 delivery summary row: `status_rank` lets the status move only forward with a conditional update
-- (`UPDATE ... IF status_rank < :rank`), `failover` records that a fallback provider sent it, `line` is
-- transactional or marketing. All nullable: older rows read as rank 0.
ALTER TABLE marketplace.deliveries ADD (status_rank int, failover boolean, line text);
