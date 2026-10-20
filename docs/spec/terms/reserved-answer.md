---
id: reserved-answer
title: RESERVED (202)
kind: term
status: draft
aliases: [reserved]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# RESERVED (202)
## Definition
`202 RESERVED` is the answer to a successful [flash-sale drop](drop.md) checkout. It means an order was created and the buyer holds one of the drop's [loaded units](drop-load.md), but has not paid yet. A drop answers this only as many times as it has loaded units; every other buyer gets [`422 out_of_stock`](out-of-stock-error.md). If the order stays unpaid past its [reservation deadline](reserved-until.md), it becomes [`CANCELLED(hold_expired)`](hold-expired.md) and the unit returns. Why the status is 202 and not 201: design intent (not stated in the spec). The likely reason is that the order is accepted but still waiting for payment.

## Example
B-07: a drop of 20 units receives 60 simultaneous checkouts. Exactly 20 answer `202 RESERVED` with total 2500, and 40 answer `422 out_of_stock`.

## Known gaps
- The spec does not say what the response body contains beyond the status and the total.
- The spec does not say the unit of the total, for example whether 2500 is in minor units.

## Used by
<!-- used-by:start -->
- [drop-load](drop-load.md)
- [drop](drop.md)
- [reserved-until](reserved-until.md)
<!-- used-by:end -->
