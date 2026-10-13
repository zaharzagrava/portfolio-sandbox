---
id: search-ranking-signals
title: Search ranking signals
kind: term
status: draft
aliases: [stock signal, stronger signal]
defined_for: S32-product-search
rules_hash: 12f8fffc6138
---
# Search ranking signals
## Definition
Ranking signals are product attributes that boost a product's rank on top of its [text relevance](text-relevance.md). The signals are stock, rating, popularity, [plan tier](plan-limit.md) and [sponsorship](sponsorship-event.md). If two products are equal except for one signal, the product with the stronger signal ranks higher. All boosts together form the [combined business multiplier](combined-business-multiplier.md). Because that multiplier is capped, an [exact text match](weak-match.md) still outranks a weak match with every boost.

## Example
Two products both match "desk lamp" equally well. One is in stock and the other is not. The in-stock product ranks first.

## Known gaps
- The spec does not give the weight of each signal or how the signals combine inside the cap.
- Not confirmed in the code: which source feeds each signal. The spec names the `marketing.product_sponsorship_changed` consumer and the [`search.refresh-popularity` job](search-refresh-popularity.md) but does not tie them to signals.
- The spec does not say how "stronger" is measured for stock. For example, it does not say whether stock means in stock versus out of stock, or a quantity.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-04
- [combined-business-multiplier](combined-business-multiplier.md)
- [plan-limit](plan-limit.md)
- [search-refresh-popularity](search-refresh-popularity.md)
- [sponsorship-event](sponsorship-event.md)
- [text-relevance](text-relevance.md)
- [weak-match](weak-match.md)
<!-- used-by:end -->
