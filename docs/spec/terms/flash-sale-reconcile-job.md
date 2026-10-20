---
id: flash-sale-reconcile-job
title: flash-sale.reconcile job
kind: term
status: draft
aliases: [flash-sale.reconcile]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# flash-sale.reconcile job
## Definition
`flash-sale.reconcile` is the job that reconciles a [drop](drop.md) after it ends. Together with [`flash-sale.end`](flash-sale-end-job.md), it returns the drop's [unsold units](unsold-units.md) to [catalog stock](catalog-stock.md). Each unsold unit goes back only once, and paid units stay sold. The drop lifecycle lists "reconciled" as one of the drop's later states.

## Example
Illustrative: a drop of 20 units ends with 12 paid. Between them, `flash-sale.end` and `flash-sale.reconcile` return the other 8 units to the product's stock. A duplicate run of `flash-sale.reconcile` changes no stock (J03.R-06, proof J03 AS-10, J03 AS-15).

## Known gaps
- The spec does not say what reconcile compares, or what it corrects that end does not.
- The spec does not say when the job runs, or whether it always runs after `flash-sale.end`.
- The spec does not say whether units released later by [`orders.expire-reservation`](orders-expire-reservation-job.md) are returned by this job.

## Used by
<!-- used-by:start -->
- [catalog-stock](catalog-stock.md)
- [drop](drop.md)
- [unsold-units](unsold-units.md)
<!-- used-by:end -->
