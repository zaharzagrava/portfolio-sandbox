---
id: product-view-event
title: product_view event
kind: term
status: draft
aliases: [product_view]
defined_for: S35-trending
rules_hash: e3b0c44298fc
---
# product_view event
## Definition
`product_view` is the event name for one buyer viewing one product, carried on the analytics.events topic. The [trending consumer](orders-events-consumer.md) counts it toward that product's [trending score](trending-score.md) with the [view weight](trending-event-weight.md). Each visitor counts at most once per product per [trending window](trending-window.md), however many views they send. The catalog decides the product's category, not the category the client attached to the event. Event names outside `product_view` and `add_to_cart` change nothing and are counted as `[ignored](consumer-outcomes.md)`.

## Example
One visitor sends 50 `product_view` events for product `A` within one minute window. `A` gains 1, and the next minute can add 1 again (S35 AS-22).
A view at 11:00:30 still counts in a ranking read at 11:59:20. At 12:01:05 it no longer counts (S35 AS-18).

## Known gaps
- The spec does not say which payload fields a `product_view` carries. It names only `event_id`, `ts`, `received_at` and the message key `anonymous_id`.
- The spec does not say which client or service publishes `product_view` events.
- The spec does not say how the visitor cap tolerates errors. Its 1% false-"seen" rate has no test with its own id, so some real views may be skipped.

## Used by
<!-- used-by:start -->
- [orders-events-consumer](orders-events-consumer.md)
- [trending-event-weight](trending-event-weight.md)
- [trending-score](trending-score.md)
- [trending-window](trending-window.md)
<!-- used-by:end -->
