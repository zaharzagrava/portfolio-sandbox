---
id: drop-reconcile
title: Drop end and reconcile
kind: term
status: draft
aliases: [end and reconcile]
defined_for: J03-launch-day
rules_hash: 5192be671c32
---
# Drop end and reconcile
## Definition
Drop end and [drop](drop.md) reconcile are the closing steps of a drop, run by the jobs [`flash-sale.end`](flash-sale-end-job.md) and [`flash-sale.reconcile`](flash-sale-reconcile-job.md). Together they return the drop's [unsold units](unsold-units.md) to the product's [catalog stock](catalog-stock.md). They return only unsold units, and only once. Paid units stay sold. The job [`orders.expire-reservation`](orders-expire-reservation-job.md) separately returns units from lapsed [drop holds](drop-hold.md).

## Example
Illustrative: a drop loads 20 units, sells 12 that are paid, and 8 remain. `flash-sale.end` and `flash-sale.reconcile` together return the 8 units to product stock. Running either job a second time returns nothing more (J03.R-06).

## Known gaps
- The spec does not say how end differs from reconcile, or which of them actually moves the units back.
- The spec does not say when each job is scheduled.
- The spec does not say how a drop hold that is still unpaid at end time is treated.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): R-06
- [catalog-stock](catalog-stock.md)
- [drop-hold](drop-hold.md)
- [drop](drop.md)
- [unsold-units](unsold-units.md)
<!-- used-by:end -->
