---
id: orders-domain
title: Orders domain
kind: term
status: draft
aliases: []
defined_for: order-reservation
rules_hash: e3b0c44298fc
---
# Orders domain
## Definition
The orders domain is the part of the backend that owns orders. At checkout it turns a cart into one order and splits it into one [shop order](shop-order.md) per seller. It [holds](reservation-status.md) stock for the order, cancels holds that stay unpaid too long, releases stock and marks orders paid from the [verified webhook event](verified-webhook-event.md). It does not own stock: it changes stock only by calling the [catalog stock command](catalog-stock-command.md), which [S05](../capabilities/S05-products.md) owns. It sets the [order statuses](order-status.md), and the web app only shows them.

## Example
Checkout for order `ord_123` holds two products. The orders domain sends one stock command, and each [operation ID](stock-operation-id.md) starts with the `orders:` prefix (IDs are illustrative):
```
orders:ord_123:reserve:prod_07
orders:ord_123:reserve:prod_42
```
The order moves from `PENDING` to `RESERVED`, and then to `PAID` when a matching verified webhook event arrives.

## Known gaps
- The spec does not say whether the orders domain is exactly [S10](../capabilities/S10-cart-checkout.md). S10 does the reserve, expire, release and mark-paid work, but the term is never mapped to a capability.
- The spec does not say which capability moves orders to `FULFILLING`, `SHIPPED` and `DELIVERED`.
- The spec does not say how [S13](../capabilities/S13-payment-intents.md)'s payment results change an order.

## Used by
<!-- used-by:start -->
- [catalog-stock-command](catalog-stock-command.md)
- [hold-expired](hold-expired.md)
- [minor-units](minor-units.md)
- [order-cancelled-event](order-cancelled-event.md)
- [order-copy](order-copy.md)
- [order-fulfilment-changed-event](order-fulfilment-changed-event.md)
- [order-status](order-status.md)
- [outbox-rollback](outbox-rollback.md)
- [realtime-topic](realtime-topic.md)
- [reservation-status](reservation-status.md)
- [reserved-until](reserved-until.md)
- [shop-order](shop-order.md)
- [stock-operation-id](stock-operation-id.md)
- [user-summary](user-summary.md)
- [verified-webhook-event](verified-webhook-event.md)
<!-- used-by:end -->
