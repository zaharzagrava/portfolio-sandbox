---
id: add-to-cart-signal
title: Add-to-cart signal
kind: term
status: draft
aliases: [add-to-cart]
defined_for: S35-trending
rules_hash: c855f87ffbd8
---
# Add-to-cart signal
## Definition
An add-to-cart signal is an `add_to_cart` event read from the [`analytics.events` topic](analytics-events-topic.md) by the [trending consumer](trending-aggregate.md). It is one of only two event names that count toward a product's [trending score](trending-score.md). The other is [`product_view`](product-view-event.md). It carries a heavier [weight](trending-event-weight.md) than a view because it shows stronger buying interest, which is design intent (not stated in the spec). Each visitor's add-to-carts are [capped per product per window](per-visitor-view-cap.md).

## Example
In the last hour, product `A` had 3 counted views and 2 counted add-to-carts. Its score is `3 × 1 + 2 × 5 = 13` (the default weights; the counts are illustrative).

## Known gaps
- The spec does not say whether this event comes from the real cart action (S10) or is only reported by the client's analytics.
- The spec does not say how an add-to-cart is weighted when the same visitor removes the item again.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-18
- [analytics-events-topic](analytics-events-topic.md)
- [cart-badge](cart-badge.md)
- [per-visitor-view-cap](per-visitor-view-cap.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-event-weight](trending-event-weight.md)
- [trending-score](trending-score.md)
- [visitor](visitor.md)
<!-- used-by:end -->
