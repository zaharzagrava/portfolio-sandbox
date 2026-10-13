---
id: stock-operation-ordering
title: Stock operation ordering
kind: term
status: draft
aliases: [sorted by ascending product id]
defined_for: order-reservation
rules_hash: 513f3bb78474
---
# Stock operation ordering
## Definition
When a [catalog stock command](catalog-stock-command.md) touches several products, its [operations](stock-operation.md) must be sorted by ascending product ID. Each product appears only once. Design intent (not stated in the spec): if every [checkout](post-checkout.md) takes products in the same order, two checkouts competing for the same products cannot [deadlock ↗](../sw-external-terms.md#deadlock) each other.

## Example
A cart has `prod_42` and `prod_07` (illustrative IDs). The command sends the `prod_07` operation first and the `prod_42` operation second, whatever order the [cart lines](cart-line.md) are in.

## Known gaps
- The spec does not say how two cart lines for the same product become one operation. Summing their quantities is the likely approach, but it is not confirmed.
- The spec does not say how product IDs are compared, for example as text or as numbers.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-20, B-12
- [order-reservation](../concepts/order-reservation.md): C-01
- [cart-line](cart-line.md)
- [catalog-stock-command](catalog-stock-command.md)
- [pending-order-recovery](pending-order-recovery.md)
- [post-checkout](post-checkout.md)
- [stock-operation](stock-operation.md)
<!-- used-by:end -->
