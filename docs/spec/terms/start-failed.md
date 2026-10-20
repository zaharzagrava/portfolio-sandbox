---
id: start-failed
title: START_FAILED
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# START_FAILED
## Definition
`START_FAILED` is the end state of a [drop](drop.md) whose [load](drop-load.md) could not take its units from [catalog stock](catalog-stock.md). The reason appears in brackets; the only reason in the spec is [`insufficient_stock`](insufficient-stock.md). A drop in this state leaves catalog stock untouched and never opens for checkout. Design intent (not stated in the spec): failing the whole load, instead of loading fewer units, keeps the rule that a drop sells exactly its units.

## Example
A brand schedules a drop of 20 units. Product stock then falls to 15 (illustrative) before [`flash-sale.load`](flash-sale-load-job.md) runs. The job leaves stock at 15 and ends the sale as `START_FAILED(insufficient_stock)` (J03.B-11, J03.R-09).

## Known gaps
- The spec does not list other `START_FAILED` reasons besides `insufficient_stock`.
- The spec does not say whether the brand is notified, or whether a failed drop can be retried or rescheduled.

## Used by
<!-- used-by:start -->
- [catalog-stock](catalog-stock.md)
- [drop-load](drop-load.md)
- [drop](drop.md)
<!-- used-by:end -->
