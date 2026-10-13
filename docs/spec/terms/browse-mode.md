---
id: browse-mode
title: Browse mode
kind: term
status: draft
aliases: [browse-mode, mode: "browse"]
defined_for: S32-product-search
rules_hash: 490a8fdb6fe8
---
# Browse mode
## Definition
Browse mode is the search mode for a [`GET /products/search`](product-search-route.md) request that has no `q`. Without query text there is no text relevance, so items are ranked only by their [business score](business-score.md), highest first. [Ties are broken by `id` ascending, which keeps the order total](search-total-order.md). The response says which mode was used in its [`mode` member](search-mode.md).

## Example
`GET /products/search?limit=20` (no `q`) answers `200` with `"mode": "browse"`. The items come back by business score from highest to lowest. Two products with equal business scores are ordered by `id` ascending.

## Known gaps
- The spec does not say whether filters and the [named sort orders](search-sort-order.md) (`price-asc`, `price-desc`, `newest`) can be combined with browse mode, or whether they replace the business-score order.
- The spec does not say whether the business score used in browse mode is the same value as the [combined business multiplier](combined-business-multiplier.md) used in text searches.
- Not confirmed in the code: the facts include no code excerpt for the search service, so how browse mode is chosen has not been checked.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-03, B-02, B-05
- [business-score](business-score.md)
- [combined-business-multiplier](combined-business-multiplier.md)
- [home-page](home-page.md)
- [rank-badge](rank-badge.md)
- [search-mode](search-mode.md)
- [search-page](search-page.md)
- [search-sort-order](search-sort-order.md)
- [search-total-order](search-total-order.md)
- [skeleton](skeleton.md)
- [streaming-section](streaming-section.md)
- [text-relevance](text-relevance.md)
- [zero-result-rate](zero-result-rate.md)
<!-- used-by:end -->
