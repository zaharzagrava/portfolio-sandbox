---
id: drop-load
title: Drop load
kind: term
status: draft
aliases: [loaded units]
defined_for: J03-launch-day
rules_hash: 50f5e999bbf1
---
# Drop load
## Definition
Drop load is the step where the job [`flash-sale.load`](flash-sale-load-job.md) moves a [drop](drop.md)'s units out of the product's catalog stock and into the drop. Scheduling a drop moves no stock; only loading does. Loading lowers product stock exactly once, even if the job runs more than once. If the product has too little stock, the load changes nothing and the drop ends as [`START_FAILED(insufficient_stock)`](start-failed.md). Design intent (not stated in the spec): delaying the move until load keeps units sellable in the catalog until the sale starts.

## Example
A brand schedules a drop of 20 units, and product stock stays unchanged. When `flash-sale.load` runs, product stock drops by 20 one time. If stock had fallen below 20 after scheduling, the sale becomes `START_FAILED(insufficient_stock)` instead (J03.B-11).

## Known gaps
- The spec does not say when the load job runs relative to the drop's start time.
- Not confirmed in the code: how "exactly once" is enforced, for example through a [stock operation id](stock-operation-id.md) or a [conditional state transition](conditional-transition.md).

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
