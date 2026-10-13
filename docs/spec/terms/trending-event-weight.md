---
id: trending-event-weight
title: Trending event weight
kind: term
status: draft
aliases: [view 1, add-to-cart 5, weighted counts]
defined_for: S35-trending
rules_hash: 6d70ebc64134
---
# Trending event weight
## Definition
An event weight is how many points one counted event adds to a product's popularity tally. Only [`product_view`](product-view-count.md) and [`add_to_cart`](add-to-cart-signal.md) have weights. Other event names change nothing and are counted as [`ignored`](consumer-outcomes.md). The weights are set through the `TRENDING_*` variables. Add-to-cart weighs more than a view, which is design intent (not stated in the spec): adding to the cart shows stronger buying interest.

## Example
Default weights: `product_view` = 1, `add_to_cart` = 5.
One visitor who views product `A` 50 times in one [window](trending-window.md) adds only 1 point, because the [visitor cap](per-visitor-view-cap.md) applies before the weight.

## Known gaps
- The spec does not name the individual `TRENDING_*` variables that hold the weights.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-05
- [add-to-cart-signal](add-to-cart-signal.md)
- [heavy-hitters](heavy-hitters.md)
- [partition-window-merge](partition-window-merge.md)
- [per-visitor-view-cap](per-visitor-view-cap.md)
- [product-view-event](product-view-event.md)
- [ranking-span](ranking-span.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-configuration](trending-configuration.md)
- [trending-score](trending-score.md)
- [trending-window](trending-window.md)
- [weighted-total](weighted-total.md)
<!-- used-by:end -->
