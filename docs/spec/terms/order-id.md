---
id: order-id
title: orderId
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: 465b47e87bdc
---
# orderId
## Definition
`orderId` is the identifier of one order, the one that checkout creates from the cart. It appears in the order routes, such as `GET /orders/:orderId` and `POST /orders/:orderId/cancel`. It is also part of every [stock operation ID](stock-operation-id.md), so each stock change can be traced back to its order. [Incoming payment events](payment-event-outcome.md) use it to find the order they belong to. An event with no `orderId`, or with one that matches no order, is stored as [`UNMATCHED`](unmatched-payment-event.md).

## Example
The buyer cancels a [reserved order](order-status.md) with `POST /orders/:orderId/cancel`. Stock for product `p_42` was reserved with this operation ID (values illustrative):
```
orders:ord_7f3a:reserve:p_42
```

## Known gaps
- The spec does not say what format `orderId` has, such as UUID, prefixed string or number.
- The spec does not say how `orderId` gets into a payment event. The [provider charge metadata](provider-charge-metadata.md) page may cover this, but [S10](../capabilities/S10-cart-checkout.md) does not say.
- The spec does not say what `GET /orders/:orderId` returns when the `orderId` belongs to another buyer. It only says the route returns "one of the buyer's own orders".

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): B-21
- [order-status](order-status.md)
- [payment-event-outcome](payment-event-outcome.md)
- [provider-charge-metadata](provider-charge-metadata.md)
- [stock-operation-id](stock-operation-id.md)
<!-- used-by:end -->
