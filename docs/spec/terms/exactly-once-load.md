---
id: exactly-once-load
title: Exactly-once load
kind: term
status: draft
aliases: [exactly once]
defined_for: J03-launch-day
rules_hash: f07697a7d742
---
# Exactly-once load
## Definition
Exactly-once load is the guarantee that a [drop load](drop-load.md) lowers [catalog stock](catalog-stock.md) one time and never more. Scheduling a drop moves no stock. Only the `flash-sale.load` job moves it. Running the load again must not lower product stock a second time. If the load fails, catalog stock stays untouched and the sale ends as [`START_FAILED(insufficient_stock)`](start-failed.md).

## Example
A brand schedules a drop, and product stock does not change. When `flash-sale.load` runs, product stock drops by the drop's units, only once (J03.R-06, proof J03 AS-10). In one illustrative case, a drop of 20 lowers stock by 20. If product stock had fallen below the drop's units after scheduling, the sale becomes `START_FAILED(insufficient_stock)` and stock stays the same (J03.R-09, J03.B-11).

## Known gaps
- Not confirmed in the code: how the single decrement is enforced. It could be a [stock operation id](stock-operation-id.md), a [conditional transition](conditional-transition.md) on the drop, or something else.
- The spec does not say what happens to a second load trigger. It may do nothing silently, or it may report a conflict.
- The spec does not say what schedules `flash-sale.load`, or whether it is one of the allow-listed jobs that tests can trigger.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
