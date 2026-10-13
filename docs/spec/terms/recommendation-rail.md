---
id: recommendation-rail
title: Recommendation rail
kind: term
status: draft
aliases: [rails]
defined_for: S34-recommendations
rules_hash: 5c593a3090c7
---
# Recommendation rail
## Definition
The recommendation rail is the "Frequently bought together" list on a product page. It shows products that other buyers paid for in the same order as this product. The rail comes from [`GET /api/products/:productId/recommendations`](get-product-recommendations.md), and it is anonymous and identical for every caller, so a CDN can cache it. [Direct neighbours](direct-neighbour.md) come first, and a [2-hop lookup](two-hop-lookup.md) tops up a product that has few of them. [Hidden products](search-visibility.md) are filtered out on every [origin request](origin-request.md), and when too few products qualify, the rail just shows fewer and never fills the gaps with unrelated ones.

## Example
After dataset D is built, an anonymous request for product `M`'s rail returns `200`. The items list `C` (score 0.2067, `hops: 1`) before `P` (score 0.1794, `hops: 1`) (S34.B-01). For product `S`, which has only one direct neighbour `K`, the rail shows `K` (0.2046, `hops: 1`) and then `P` (0.0673, `hops: 2`) (S34.B-06).

## Known gaps
- The spec does not say the full shape of a rail item. The behaviors only show a product, a score and `hops`.
- The spec does not say whether the product page hides the rail when the endpoint returns `items: []`.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-01, B-01, B-19
- [basket-type-parameter](basket-type-parameter.md)
- [direct-neighbour](direct-neighbour.md)
- [get-product-recommendations](get-product-recommendations.md)
- [home-page](home-page.md)
- [no-padding](no-padding.md)
- [origin-request](origin-request.md)
- [product-id](product-id.md)
- [rank-badge](rank-badge.md)
- [search-visibility](search-visibility.md)
- [showcase-blocks](showcase-blocks.md)
- [skeleton](skeleton.md)
- [static-shell](static-shell.md)
- [streaming-section](streaming-section.md)
- [two-hop-lookup](two-hop-lookup.md)
- [window-minutes](window-minutes.md)
<!-- used-by:end -->
