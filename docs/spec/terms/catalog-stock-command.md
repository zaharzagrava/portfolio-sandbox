---
id: catalog-stock-command
title: Catalog stock command
kind: term
status: draft
aliases: [stock command]
defined_for: order-reservation
rules_hash: 85756310bcfe
---
# Catalog stock command
## Definition
The catalog stock command is the only way any part of the system may change product stock. [S05](../capabilities/S05-products.md) owns the stock fields and exports this command. Other domains change stock only by calling it, including the part of the system that handles orders when it [reserves](all-or-nothing-reservation.md), expires or releases stock. Each call carries a list of stock changes, one per product, sorted by product ID.

## Example
Checkout for order `ord_123` reserves two products, so the orders domain sends one command with two operations (all values are illustrative):
```
orders:ord_123:reserve:prod_07
orders:ord_123:reserve:prod_42
```

## Known gaps
- The spec does not say the command's name, its input shape, or whether it is a function call or a network call.
- The spec does not say how S05 applies the command to a reservation. S05's page has no line that links this concept.
- The spec does not say whether the command itself stops stock from going negative, or whether the caller has to check.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-20
- [order-reservation](../concepts/order-reservation.md): C-01
- [all-or-nothing-reservation](all-or-nothing-reservation.md)
- [capability](capability.md)
- [cart-line](cart-line.md)
- [checkout-unavailable](checkout-unavailable.md)
- [orders-domain](orders-domain.md)
- [pending-order-recovery](pending-order-recovery.md)
- [stock-operation-ordering](stock-operation-ordering.md)
- [stock-operation](stock-operation.md)
- [stock-release](stock-release.md)
<!-- used-by:end -->
