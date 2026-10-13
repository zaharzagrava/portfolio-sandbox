---
id: reservation-status
title: Reservation status
kind: term
status: draft
aliases: [held, release_pending]
defined_for: order-reservation
rules_hash: 15d9bd2bd2cc
---
# Reservation status
## Definition
A reservation status is the state of a single [stock hold](all-or-nothing-reservation.md) that belongs to an order. It is separate from the [order status](order-status.md). The spec names two values. `HELD` means the stock is currently taken from the product. `RELEASE_PENDING` means the order was cancelled and the stock still has to be returned.

## Example
After a successful checkout, the reservation for product `7` on order `42` (illustrative) is `HELD`. When the order is cancelled, it becomes `RELEASE_PENDING` in the same transaction.

## Known gaps
- The spec does not list every reservation status. The state after a successful release is not named.
- The spec does not say whether there is one reservation per product line, per shop order, or per order. One [stock operation](stock-operation.md) per product suggests per product, but this is not confirmed.

## Used by
<!-- used-by:start -->
- [all-or-nothing-reservation](all-or-nothing-reservation.md)
- [order-status](order-status.md)
- [orders-domain](orders-domain.md)
- [out-of-stock-error](out-of-stock-error.md)
- [shop-order](shop-order.md)
- [stock-operation](stock-operation.md)
<!-- used-by:end -->
