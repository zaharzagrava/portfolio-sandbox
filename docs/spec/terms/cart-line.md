---
id: cart-line
title: Cart line
kind: term
status: draft
aliases: []
defined_for: order-reservation
rules_hash: 1217902d3c46
---
# Cart line
## Definition
A cart line is one product in a buyer's cart, together with the quantity the buyer wants. At checkout, the cart lines decide which [stock operations](stock-operation.md) the [catalog stock command](catalog-stock-command.md) carries. The reservation is [all or nothing](all-or-nothing-reservation.md): if any line is short of stock, nothing is held and the order fails with [`out_of_stock`](out-of-stock-error.md). The order of the lines in the cart has no effect, because operations are always [sorted by product ID](stock-operation-ordering.md).

## Example
A cart holds two lines: 3 × `prod_42` and 1 × `prod_07` (illustrative). Suppose `prod_07` has no stock left. Then neither product is held, the order becomes `CANCELLED(out_of_stock)` and the buyer gets `422 out_of_stock`.

## Known gaps
- The spec does not say how two lines for the same product are combined into one operation.
- The spec does not say how cart lines are combined when a [guest cart](guest-cart.md) is merged at login.
- The spec does not say which fields a cart line holds besides the product and quantity, for example a saved price.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-04, R-05, R-18, B-02, B-04
- [W03](../capabilities/W03-cart-checkout-orders.md): B-03
- [all-or-nothing-reservation](all-or-nothing-reservation.md)
- [basket](basket.md)
- [cart-empty](cart-empty.md)
- [cart-line-limit](cart-line-limit.md)
- [cart-unit-count](cart-unit-count.md)
- [catalog-stock-command](catalog-stock-command.md)
- [discount-tie-break](discount-tie-break.md)
- [get-cart](get-cart.md)
- [guest-cart](guest-cart.md)
- [line-position](line-position.md)
- [optimistic-update](optimistic-update.md)
- [seller-discount](seller-discount.md)
- [stock-operation-ordering](stock-operation-ordering.md)
- [stock-operation](stock-operation.md)
<!-- used-by:end -->
