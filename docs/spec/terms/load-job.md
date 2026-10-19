---
id: load-job
title: Load job
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: 9df55c86c0eb
---
# Load job
## Definition
The load job is the scheduled job [`flash-sale.load`](flash-sale-load-job.md). It moves stock from the catalog product into a [flash-sale drop](drop.md). Scheduling a drop moves no stock; only this job lowers product stock, and it does so [exactly once](drop-load.md). If the product no longer has enough stock, the job leaves [catalog stock](catalog-stock.md) untouched and ends the sale as [`START_FAILED(insufficient_stock)`](start-failed.md).

## Example
A brand schedules a drop of 20 units. Before the load job runs, the product's stock falls to 15 (illustrative). When `flash-sale.load` runs, catalog stock stays at 15 and the sale becomes `START_FAILED(insufficient_stock)`.

## Known gaps
- The spec does not say when the load job runs relative to the drop's start time, or what triggers it.
- The spec does not say how "exactly once" is enforced if the job is retried or fires twice.
- The spec does not say whether a `START_FAILED` drop notifies the brand.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
