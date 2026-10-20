---
id: flash-sale-end-job
title: flash-sale.end job
kind: term
status: draft
aliases: [flash-sale.end]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# flash-sale.end job
## Definition
`flash-sale.end` is the job that ends a [drop](drop.md). Together with [`flash-sale.reconcile`](flash-sale-reconcile-job.md), it returns the drop's [unsold units](unsold-units.md) to catalog stock. It returns only unsold units, and only once, so paid units stay sold. Like every job in this system, it reads time from the [injected clock](injected-clock.md), so tests can make a drop due.

## Example
From J03.B-07: a drop loads 20 units, and 60 buyers check out at the same moment. Exactly 20 get [`202 RESERVED`](reserved-answer.md) and 40 get [`422 out_of_stock`](out-of-stock-error.md). Illustrative: if 12 of the reserved orders are paid when the drop ends, the 8 remaining units go back to the product's stock. Running the job a second time returns nothing more (J03.R-06).

## Known gaps
- The spec does not say how end differs from reconcile, or which of the two actually moves units back.
- The spec does not say when the job runs. The drop lifecycle lists an "ended" state, but no rule says this job sets it.
- The spec does not say how a [drop hold](drop-hold.md) that is still unpaid when the drop ends is counted.

## Used by
<!-- used-by:start -->
- [drop-hold](drop-hold.md)
- [drop](drop.md)
- [injected-clock](injected-clock.md)
- [unsold-units](unsold-units.md)
<!-- used-by:end -->
