---
id: seller-discount
title: Seller discount
kind: term
status: draft
aliases: [discount]
defined_for: S10-cart-checkout
rules_hash: 0b612d557ae0
---
# Seller discount
## Definition
A seller discount is an amount, in [minor units](minor-units.md), that lowers what a buyer pays to one shop. At checkout, the discount is spread across that [shop's lines](cart-line.md) using the [largest-remainder method ↗](../sw-external-terms.md#largest-remainder-method), and when lines tie, the line that comes first in the shop's list wins. Each line total is unit price × quantity − its share of the discount, and it never goes below zero. The [shop subtotal](shop-subtotal.md) and the [order total](order-total.md) fall by the discount.

## Example
A shop's lines gross `2000` and the seller discount is `300`. The shop order subtotal becomes `1700`, and the order total drops by `300`.

## Known gaps
- The spec does not say where a seller discount is defined or who configures it. It also does not say whether it can be a percentage or only a fixed amount.
- The spec does not say what happens when the discount is larger than the shop's gross. Line totals are floored at zero, but the spec does not say what happens to the leftover discount.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): B-10
- [cart-line](cart-line.md)
- [discount-tie-break](discount-tie-break.md)
- [line-position](line-position.md)
- [line-total-minor](line-total-minor.md)
- [minor-units](minor-units.md)
- [order-total](order-total.md)
- [orders-backfill-item-titles-job](orders-backfill-item-titles-job.md)
- [shop-subtotal](shop-subtotal.md)
<!-- used-by:end -->
