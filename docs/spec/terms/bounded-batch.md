---
id: bounded-batch
title: Bounded batch
kind: term
status: draft
aliases: [batch, bounded batches]
defined_for: S53-events-projections
rules_hash: 62ad1f4bf515
---
# Bounded batch
## Definition
A bounded batch is one delete statement in a purge job, capped at a fixed maximum number of rows. The [outbox purge job](outbox-purge-job.md) deletes old [published rows](published-row.md) in a series of these capped batches, not all at once. The size limit is set in the rule for the outbox purge job, not here. Design intent (not stated in the spec): each delete stays short, so it does not hold locks for long or slow down the [relay](outbox-relay.md) and [`append`](outbox-append.md) writers on the outbox table.

## Example
Assume the purge job finds 2,500 outbox rows (illustrative) that were published more than 7 days ago. With the 1,000-row cap from S53.R-15, it deletes them in three batches: 1,000, then 1,000, then 500. [Pending rows](pending-row.md) and [parked rows](parked-row.md) are never in any batch.

## Known gaps
- The spec does not say whether the inbox purge job for terminal inbox rows uses bounded batches, or what its batch size is.
- The spec does not say whether one purge run keeps going until no eligible rows are left, or stops after a single batch.
- The spec does not say whether the job pauses between batches.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): B-19
- [S32](../capabilities/S32-product-search.md): B-14
- [catalog-shop-purge](catalog-shop-purge.md)
- [invite-purge-job](invite-purge-job.md)
- [order-items-backfill](order-items-backfill.md)
- [orders-backfill-item-titles-job](orders-backfill-item-titles-job.md)
- [outbox-purge-job](outbox-purge-job.md)
- [outbox-relay](outbox-relay.md)
- [parked-row](parked-row.md)
- [pending-row](pending-row.md)
- [published-row](published-row.md)
- [shop-deleted-event](shop-deleted-event.md)
- [shop-status-changed-event](shop-status-changed-event.md)
- [shop-status-consumer](shop-status-consumer.md)
<!-- used-by:end -->
