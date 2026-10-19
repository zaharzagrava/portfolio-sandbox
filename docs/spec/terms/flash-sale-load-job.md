---
id: flash-sale-load-job
title: flash-sale.load job
kind: term
status: draft
aliases: [flash-sale.load]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# flash-sale.load job
## Definition
`flash-sale.load` is the job that performs the [drop load](drop-load.md). It moves the [drop's units](drop.md) out of the product's [catalog stock](catalog-stock.md). Scheduling a drop moves no stock; only this job does. It lowers product stock [exactly once](exactly-once-load.md), even if the job is triggered more than once. If the product has too little stock, it leaves catalog stock untouched and the sale ends as [`START_FAILED(insufficient_stock)`](start-failed.md).

## Example
A brand schedules a drop of 20 units, and product stock stays the same. When `flash-sale.load` runs, product stock falls by 20, one time only (J03.R-06). If stock had fallen below 20 after scheduling, the sale becomes `START_FAILED(insufficient_stock)` instead (J03.B-11).

## Known gaps
- The spec does not say when the job runs relative to the drop's start time, or what schedules it.
- Not confirmed in the code: how "exactly once" is enforced, for example through a stock operation id or a [conditional transition](conditional-transition.md) on the drop.
- The spec does not say whether `flash-sale.load` is one of the allow-listed jobs that the control surface can trigger in tests.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
