# AuctionBidDefaultPartition

**Severity:** ticket · **Owner:** commerce · **Dashboards:** *Auctions*

## What it means
Bids are landing in `Bid_default` (`auction_bid_default_partition_rows` > 0) because the monthly partition for their month does not exist. Bidding is unaffected (a bid never fails for a missing partition) but the default partition grows, and creating the missing month later needs the rows moved out of it first.

## Triage (≤ 5 min)
1. Which months exist? `SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = '"Bid"'::regclass ORDER BY 1;`
2. Did the daily job run? Worker logs `{service="worker"} |= "ensure-bid-partitions"`; the schedule `auctions.ensure-bid-partitions` (daily 03:17 UTC).

## Mitigate
- Rows are already in `Bid_default` for the missing month: Postgres refuses to create that month's partition while the default holds rows in its range, so the job fails until they are moved. In a maintenance window copy them out (`CREATE TEMP TABLE moved AS SELECT * FROM "Bid_default" WHERE "createdAt" >= '<month start>' AND "createdAt" < '<next month>'`), delete them from the default, create the partition (`SELECT bid_ensure_partitions('<month start>'::date, 1);`), insert the rows back into `"Bid"`.
- Nothing parked yet: run the job once from the job console, or `SELECT bid_ensure_partitions(date_trunc('month', now())::date, 4);`.

## Verify
`auction_bid_default_partition_rows` returns to 0 after the next job run.

## Follow-up
Find out why the daily job did not run (lease, schedule disabled, worker down).
