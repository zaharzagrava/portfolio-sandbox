---
id: product-created-event
title: product.created event
kind: term
status: draft
aliases: [product.created]
defined_for: J02-seller-to-first-sale
rules_hash: e3b0c44298fc
---
# product.created event
## Definition
`product.created` is the event a shop's systems receive when the owner creates a product. It is delivered to the shop's [webhook endpoint](webhook-endpoint), not read by internal consumers. Search builds its documents separately, from the [catalog.product_* events](catalog-product-events.md). In the seller journey, receiving it proves the hand-off from catalog to the shop's own systems.

## Example
The owner of a shop on an active plan sends `POST` to create product `P1` with an `[Idempotency-Key](idempotency-key.md)`. The product becomes searchable, and the shop's receiver `R` gets one `product.created`.

## Known gaps
- The spec does not say which fields `product.created` carries, or whether it is signed like `[order.paid](order-paid-event.md)`.
- The spec does not say how `product.created` relates to the internal catalog.product_* events. For example, it does not say whether it is derived from a catalog product-created event.
- The spec does not say whether a [replay](event-replay.md) of [`products.events`](products-events-topic.md) can re-send `product.created`. J02.R-15 only covers entitlements, plan, rank, revenue, stock and search.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
