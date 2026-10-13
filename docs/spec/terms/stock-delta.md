---
id: stock-delta
title: Stock delta
kind: term
status: draft
aliases: [deltas]
defined_for: S05-products
rules_hash: 8e5416fd7cb5
---
# Stock delta
## Definition
A stock delta is the signed change in a product's stock that another domain sends to [`ProductStockService.applyStockDelta`](apply-stock-delta.md). A negative delta removes stock and a positive delta adds it. The change is applied [all-or-nothing](all-or-nothing-reservation.md) and is [idempotent ↗](../sw-external-terms.md#idempotency) by its [`operationId`](stock-operation-id.md). If a delta would take stock below zero or above the highest amount a product may hold, it is refused and stock stays as it was.

## Example
Stock is 5, and ten concurrent operations each send a delta of `-1`. Five apply and five return [`insufficient_stock`](insufficient-stock.md), so stock ends at 0. If one applied `operationId` is sent again, the result is [`replayed: true`](stock-operation-replayed.md) with the original [`quantityAfter`](quantity-after.md).

## Known gaps
- The spec does not say whether a delta of zero is accepted, refused or treated as a no-op.
- The spec does not say whether one `applyStockDelta` call can carry deltas for several products, or only for one.
- The spec does not say which result or code is returned when a positive delta would go past the stock upper bound.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): B-08
- [all-or-nothing-reservation](all-or-nothing-reservation.md)
- [apply-delta](apply-delta.md)
- [catalog-domain-layer](catalog-domain-layer.md)
- [insufficient-stock](insufficient-stock.md)
- [stock-operation-replayed](stock-operation-replayed.md)
- [stock-upper-bound](stock-upper-bound.md)
<!-- used-by:end -->
