---
id: order-status
title: Order status
kind: term
status: draft
aliases: [cancelled, order statuses]
defined_for: order-reservation
rules_hash: 6047b3ce19f3
---
# Order status
## Definition
An order status is the lifecycle state of an order. The possible statuses are `PENDING`, [`RESERVED`](all-or-nothing-reservation.md), `PAID`, `FULFILLING`, `SHIPPED`, `DELIVERED`, `CANCELLED` and `REFUNDED`. Only the backend changes the status. The web app only shows it. A `CANCELLED` order also carries a reason, such as [`out_of_stock`](out-of-stock-error.md) or [`hold_expired`](hold-expired.md).

## Example
A typical path is `PENDING` → `RESERVED` → `PAID`. [W03](../capabilities/W03-cart-checkout-orders.md) shows these to the buyer as "Processing" → "Awaiting payment" → "Paid". A failed reservation ends as `CANCELLED(out_of_stock)` and is shown as "Cancelled".

## Known gaps
- The spec does not say which capability moves orders to `FULFILLING`, `SHIPPED` and `DELIVERED`.
- The spec does not say how the cancel reason is stored: as part of the status or as a separate field.
- The spec does not say what moves an order to `REFUNDED`, or how payment results from [S13](../capabilities/S13-payment-intents.md) change the status.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-33, B-17
- [S13](../capabilities/S13-payment-intents.md): B-01
- [W03](../capabilities/W03-cart-checkout-orders.md): B-18, B-19
- [order-reservation](../concepts/order-reservation.md): C-08
- [get-shop-orders](get-shop-orders.md)
- [order-command](order-command.md)
- [order-id](order-id.md)
- [order-status-history](order-status-history.md)
- [order-version](order-version.md)
- [orders-domain](orders-domain.md)
- [rejected-payment-event](rejected-payment-event.md)
- [reservation-status](reservation-status.md)
- [shop-order](shop-order.md)
- [stock-operation-id](stock-operation-id.md)
<!-- used-by:end -->
