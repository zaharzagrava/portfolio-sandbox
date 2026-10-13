---
id: stock-operation-id
title: Stock operation ID
kind: term
status: draft
aliases: [operation id]
defined_for: order-reservation
rules_hash: 27460481678d
---
# Stock operation ID
## Definition
Each [stock operation](stock-operation.md) has an ID built from the order and the product: `orders:<orderId>:reserve:<productId>`. The ID depends only on the order and the product, so a repeated operation always gets the same ID. This matters when a [`PENDING` order](order-status.md) is [recovered](pending-order-recovery.md) by repeating the same stock operations. Design intent (not stated in the spec): [S05](../capabilities/S05-products.md) can recognise an ID it has already applied, so [a retry never reserves the same stock twice ↗](../sw-external-terms.md#idempotency).

## Example
```
orders:ord_123:reserve:prod_07
```
(`ord_123` and `prod_07` are illustrative.)

## Known gaps
- Not confirmed in the code: S05 actually removes duplicate operation IDs.
- The spec does not say the ID format for [releasing stock](stock-release.md) when [a hold expires](hold-expired.md) or an order is cancelled.

## Used by
<!-- used-by:start -->
- [apply-delta](apply-delta.md)
- [hold-expired](hold-expired.md)
- [order-id](order-id.md)
- [order-status](order-status.md)
- [orders-domain](orders-domain.md)
- [pending-order-recovery](pending-order-recovery.md)
- [product-stock-service](product-stock-service.md)
- [shop-order](shop-order.md)
- [stock-operation](stock-operation.md)
- [stock-release](stock-release.md)
<!-- used-by:end -->
