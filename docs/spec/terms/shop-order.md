---
id: shop-order
title: Shop order
kind: term
status: draft
aliases: [shop orders]
defined_for: order-reservation
rules_hash: 22a47462954c
---
# Shop order
## Definition
A shop order is the part of an order that belongs to one [seller](tenant.md). At checkout, [S10](../capabilities/S10-cart-checkout.md) creates one order and splits it into one shop order per seller. One cart can hold products from several sellers, so one order can have several shop orders. The [stock hold](reservation-status.md), its expiry and the [paid mark](paid-mark.md) are all stated for the whole order, not for each shop order.

## Example
A buyer checks out one cart with products from two sellers (the IDs below are made up):
```
order ord_123
├── shop order for shop_A: prod_07
└── shop order for shop_B: prod_42
```
[Stock operation IDs](stock-operation-id.md) still use the order ID, not a shop order ID: `orders:ord_123:reserve:prod_07`.

## Known gaps
- The spec does not say whether a shop order has its own [order status](order-status.md), or only the parent order does.
- The spec does not say whether one shop order can be cancelled, paid or refunded on its own, apart from the other shop orders in the same order.
- The spec does not say which capability uses shop orders after the split, for example for fulfilment or shipping by each seller.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-14, R-36, B-05
- [discount-tie-break](discount-tie-break.md)
- [get-order-by-id](get-order-by-id.md)
- [get-shop-orders](get-shop-orders.md)
- [line-position](line-position.md)
- [order-status](order-status.md)
- [order-total](order-total.md)
- [orders-domain](orders-domain.md)
- [paid-mark](paid-mark.md)
- [reservation-status](reservation-status.md)
- [shop-subtotal](shop-subtotal.md)
- [stock-operation-id](stock-operation-id.md)
- [tenant](tenant.md)
<!-- used-by:end -->
