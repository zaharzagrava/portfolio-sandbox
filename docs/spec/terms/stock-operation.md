---
id: stock-operation
title: Stock operation
kind: term
status: draft
aliases: [operation]
defined_for: order-reservation
rules_hash: 5324f31b8da3
---
# Stock operation
## Definition
A stock operation is one entry in a request to change catalog stock, and it changes the stock of a single product. When a request covers several products, it carries one operation per product, sent in a fixed order. Each operation has its own identifier, built from the order and the product. When an unfinished order is retried, the same operations are sent again, so the identifiers let a repeat be recognised instead of applied twice. That last point is design intent (not stated in the spec).

## Example
Checkout reserves stock for order `ord_123`, which contains `prod_07` and `prod_42` (illustrative IDs). The command carries two operations, in this order:
```
orders:ord_123:reserve:prod_07
orders:ord_123:reserve:prod_42
```

## Known gaps
- The spec does not say which fields an operation carries besides its ID, such as the quantity or whether it reserves or returns stock.
- The spec does not say how two [cart lines](cart-line.md) for the same product become one operation. Summing their quantities is likely, but it is not confirmed.
- The spec does not say what operation ID format a [stock release](stock-release.md) uses. The only format given is the one for reserving.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): B-14, B-18
- [S10](../capabilities/S10-cart-checkout.md): R-20, R-24
- [acceptance-scenario](acceptance-scenario.md)
- [cart-line](cart-line.md)
- [catalog-stock-command](catalog-stock-command.md)
- [insufficient-stock](insufficient-stock.md)
- [pending-order-recovery](pending-order-recovery.md)
- [product-stock-service](product-stock-service.md)
- [reservation-status](reservation-status.md)
- [stock-operation-id](stock-operation-id.md)
- [stock-operation-ordering](stock-operation-ordering.md)
- [stock-release](stock-release.md)
- [stock-upper-bound](stock-upper-bound.md)
<!-- used-by:end -->
