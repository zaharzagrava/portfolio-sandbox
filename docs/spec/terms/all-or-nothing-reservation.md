---
id: all-or-nothing-reservation
title: All-or-nothing reservation
kind: term
status: draft
aliases: [reservation]
defined_for: order-reservation
rules_hash: f73bf8a9618b
---
# All-or-nothing reservation
## Definition
A reservation at checkout either holds stock for every line of the order or holds no stock at all. If even one line does not have enough stock, nothing is held. The order then becomes [`CANCELLED(out_of_stock)`](order-status.md) and the buyer gets an error saying the items are not in stock. A buyer is never left with only part of their cart reserved.

## Example
The cart asks for 2 of `prod_07` (5 in stock) and 3 of `prod_42` (only 1 in stock). All values are illustrative. No stock is held for either product, the order is `CANCELLED(out_of_stock)`, and the buyer gets `422 out_of_stock`.

## Known gaps
- The spec does not say how this is achieved. It could be one [atomic ↗](../sw-external-terms.md#database-transaction) [catalog stock command](catalog-stock-command.md), or the system could undo lines that already succeeded.
- The spec does not say whether the buyer is told which lines were short.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-19
- [S10](../capabilities/S10-cart-checkout.md): R-21, B-05, B-14
- [order-reservation](../concepts/order-reservation.md): C-02
- [apply-stock-delta](apply-stock-delta.md)
- [cart-line](cart-line.md)
- [catalog-stock-command](catalog-stock-command.md)
- [in-stock-filter](in-stock-filter.md)
- [insufficient-stock](insufficient-stock.md)
- [order-not-payable](order-not-payable.md)
- [order-unavailable](order-unavailable.md)
- [out-of-stock-error](out-of-stock-error.md)
- [pending-order-recovery](pending-order-recovery.md)
- [reservation-status](reservation-status.md)
- [reserved-until](reserved-until.md)
- [stock-delta](stock-delta.md)
<!-- used-by:end -->
