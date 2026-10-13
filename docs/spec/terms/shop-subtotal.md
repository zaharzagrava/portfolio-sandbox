---
id: shop-subtotal
title: Shop subtotal
kind: term
status: draft
aliases: [subtotal]
defined_for: S10-cart-checkout
rules_hash: e5c155343e46
---
# Shop subtotal
## Definition
A shop subtotal is the money one [shop order](shop-order.md) is worth: the sum of the line totals of that shop's lines. Each line total is unit price × quantity minus that line's discount. Adding up the subtotals of every shop in a checkout gives the whole checkout's amount. All amounts are integer [minor units](minor-units.md), and prices come from the catalog, never from the client.

## Example
A [seller discount](seller-discount.md) of 300 on a shop grossing 2000 gives a shop subtotal of 1700, and the order total drops by 300. In S10.B-05, shop S1 (A × 2 at 1000) and shop S2 (B × 1 at 500) each get their own shop order with its own subtotal.

## Known gaps
- The spec does not say whether shipping, tax or fees are part of a shop subtotal. Only line totals are mentioned.
- The spec does not say how a seller discount is split across the shop's lines beyond "[largest-remainder method ↗](../sw-external-terms.md#largest-remainder-method), [ties by line position](discount-tie-break.md)" (S10.R-15).

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): B-10
- [W03](../capabilities/W03-cart-checkout-orders.md): R-05
- [discount-tie-break](discount-tie-break.md)
- [expected-total-minor](expected-total-minor.md)
- [minor-units](minor-units.md)
- [order-total](order-total.md)
- [seller-discount](seller-discount.md)
- [shop-order](shop-order.md)
<!-- used-by:end -->
