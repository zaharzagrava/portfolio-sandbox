---
id: drop
title: Drop (limited-stock sale)
kind: term
status: draft
aliases: [drops]
defined_for: J03-launch-day
rules_hash: 1d72e09f8d8b
---
# Drop (limited-stock sale)
## Definition
A drop is a limited-stock flash sale that a brand schedules for one product. It sells exactly the units loaded into it, and never more. [Jobs](job.md) move it through its states: `SCHEDULED`, then loaded, then ended or reconciled. If loading fails, the drop ends in [`START_FAILED`](start-failed.md). A buyer refused because no units are left gets [`422 out_of_stock`](out-of-stock-error.md), and no order is created.

## Example
A drop has 20 units and receives 60 simultaneous checkouts. Exactly 20 checkouts answer [`202 RESERVED`](reserved-answer.md) with total 2500, and the other 40 answer `422 out_of_stock` (J03.B-07). When the sale reaches 0 units, the shop owner gets one [`shop.flash_sale_sold_out`](flash-sale-sold-out-notification.md) [inbox item](inbox-item.md) and staff get none (J03.B-10).

## Known gaps
- The spec does not give exact state names for "loaded", "ended" and "reconciled". Only `SCHEDULED` and `START_FAILED` are quoted.
- The spec does not say the currency or the unit (major or minor) of the total 2500.
- The spec does not say whether a buyer may buy more than one unit of a drop.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
