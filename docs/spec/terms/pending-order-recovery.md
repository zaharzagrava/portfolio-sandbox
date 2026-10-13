---
id: pending-order-recovery
title: Pending order recovery
kind: term
status: draft
aliases: [recovered]
defined_for: order-reservation
rules_hash: 9c11bbc1e2cc
---
# Pending order recovery
## Definition
Pending order recovery handles an order that got stuck in [`PENDING`](order-status.md) during checkout, for example because a crash interrupted its [stock reservation](all-or-nothing-reservation.md). Once the order has been `PENDING` longer than the rule allows, the backend sends the exact same [stock operations](stock-operation.md) again. Each operation keeps the identifier it had the first time and follows the same [ascending product ID order](stock-operation-ordering.md). That lets the order finish reserving its stock, or be cancelled with [`out_of_stock`](out-of-stock-error.md).

## Example
Order `42` (illustrative) has been `PENDING` for 90 s. Recovery resends `orders:42:reserve:7` and then `orders:42:reserve:19`. These are the same IDs as the first attempt.

## Known gaps
- The spec does not say that the [catalog stock command](catalog-stock-command.md) skips an operation ID it has already applied. Recovery is only safe if it does. That reason is design intent (not stated in the spec).
- The spec does not say which job finds stuck `PENDING` orders or how often it runs.
- The spec does not say whether [`reservedUntil`](reserved-until.md) is counted from the original attempt or from the recovery.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-22
- [order-reservation](../concepts/order-reservation.md): C-06
- [all-or-nothing-reservation](all-or-nothing-reservation.md)
- [catalog-stock-command](catalog-stock-command.md)
- [order-cancelled-event](order-cancelled-event.md)
- [reserved-until](reserved-until.md)
- [stock-operation-id](stock-operation-id.md)
- [stock-operation-ordering](stock-operation-ordering.md)
- [stock-operation](stock-operation.md)
<!-- used-by:end -->
