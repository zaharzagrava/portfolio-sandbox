---
id: trending-score
title: Trending score
kind: term
status: draft
aliases: [score]
defined_for: S35-trending
rules_hash: 4ef07d4dbca0
---
# Trending score
## Definition
The trending score is the number that ranks a product in the "Trending now" list. It is the sum of the product's [weighted counts](trending-event-weight.md) over the [trending windows](trending-window.md) that end at the most recent whole minute. Items are sorted by score from high to low, and equal scores are sorted by [`productId`](product-id.md) from low to high. The [visitor cap](per-visitor-view-cap.md) limits how much one visitor can add per window.

## Example
In the last hour a product got 3 views and 2 [add-to-carts](add-to-cart-signal.md) (illustrative), so its score is `3×1 + 2×5 = 13`.
If `B` gets 20 points in [partition](idle-partition.md) `p1` and 15 in `p2`, the [aggregate](trending-aggregate.md) holds `B 35` once both windows close.

## Known gaps
- The spec does not say whether the served score is the [Count-Min Sketch ↗](../sw-external-terms.md#count-min-sketch) estimate or an exact count. The sketch never undercounts, but it can overcount.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-05
- [W02](../capabilities/W02-storefront-discovery.md): B-19
- [add-to-cart-signal](add-to-cart-signal.md)
- [get-trending](get-trending.md)
- [idle-partition](idle-partition.md)
- [per-visitor-view-cap](per-visitor-view-cap.md)
- [product-view-event](product-view-event.md)
- [ranking-span](ranking-span.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-event-weight](trending-event-weight.md)
- [trending-minute-window](trending-minute-window.md)
- [trending-window](trending-window.md)
- [weighted-total](weighted-total.md)
<!-- used-by:end -->
