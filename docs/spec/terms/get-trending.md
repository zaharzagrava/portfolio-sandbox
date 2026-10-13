---
id: get-trending
title: GET /api/trending
kind: term
status: draft
aliases: [/api/trending, trending endpoint]
defined_for: S35-trending
rules_hash: a0bbeafb5146
---
# GET /api/trending
## Definition
`GET /api/trending` is the one public read of the trending ranking. It returns the products with the highest [trending score](trending-score.md), either across the whole catalog or within one group of products. It answers anonymous callers, and every caller gets the same body, whoever they are. [Only the ranking is cached.](trending-ranking-cache.md) Product facts and [search visibility](search-visibility.md) are read again on every [origin request](origin-request.md), so hidden products are dropped and the next visible ones move up. If the [trending aggregate](trending-aggregate.md) or a catalog lookup fails, it answers [`trending_unavailable`](trending-unavailable.md), and calls above the [`discovery.trending` rate limit policy](rate-limit-policy.md) get [`rate_limited`](rate-limited.md).

## Example
The home page "Trending now" rail asks for the top two audio products:
```
GET /api/trending?category=audio&limit=2

200 OK
[Cache-Control: public, max-age=30, s-maxage=30 ↗](../sw-external-terms.md#cache-control)

{ "windowMinutes": 60, "items": [ { "productId": "p-17", "category": "audio", "score": 42 }, ... ] }
```
The product IDs and scores are illustrative, and the item shape is shown only in part.

## Known gaps
- The spec does not say the full response body shape. The facts name only [`windowMinutes`](trending-window.md), `items`, each item's score, `productId` and catalog category, and that the home page shows a price and a product link.
- The spec does not say which error code a bad `limit` or an unknown query parameter returns. Only the rule for `category` names [`validation_failed`](validation-failed-error.md).
- The spec does not say how the home page rail or the product-page composition handles an empty list, `429` or `503`. AS-41 and AS-42 are tested, but no rule describes this behavior.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): B-01
- [catalog-category](catalog-category.md)
- [category-tracking](category-tracking.md)
- [clamping](clamping.md)
- [dataset-t](dataset-t.md)
- [origin-request](origin-request.md)
- [rank-badge](rank-badge.md)
- [rate-limit-policy](rate-limit-policy.md)
- [search-visibility](search-visibility.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-limit](trending-limit.md)
- [trending-ranking-cache](trending-ranking-cache.md)
- [trending-score](trending-score.md)
- [unknown-query-parameter](unknown-query-parameter.md)
- [window-minutes](window-minutes.md)
<!-- used-by:end -->
