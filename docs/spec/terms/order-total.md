---
id: order-total
title: Order total
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: 5d6a60db7b74
---
# Order total
## Definition
The order total is the amount the buyer owes for the whole order, in [minor units](minor-units.md). It is the sum of the [shop subtotals](shop-subtotal.md), one per [shop order](shop-order.md). Checkout calculates it on the server from catalog prices and never trusts a price sent by the client. If the client sends an [`expectedTotalMinor`](expected-total-minor.md) that does not match this total, checkout answers [`price_changed`](price-changed.md).

## Example
The cart holds A × 2. A now costs `1200`, so the server's order total is `2400`. The client sent `expectedTotalMinor: 2000`, so [`POST /checkout`](post-checkout.md) answers `409 price_changed` with the current total (S10.B-06).

## Known gaps
- The spec does not say whether the order total includes shipping, tax or other fees. It only defines it as the sum of the shop subtotals.
- The spec does not say whether the payment amount checked in S10.R-27 is the order total. It only says the amount must "match the order".
- The spec does not say how one order total works when shops in the cart use different currencies.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): B-01
- [S10](../capabilities/S10-cart-checkout.md): B-10
- [W03](../capabilities/W03-cart-checkout-orders.md): B-07
- [checkout-review-step](checkout-review-step.md)
- [line-total-minor](line-total-minor.md)
- [minor-units](minor-units.md)
- [seller-discount](seller-discount.md)
- [shop-order](shop-order.md)
- [shop-subtotal](shop-subtotal.md)
<!-- used-by:end -->
