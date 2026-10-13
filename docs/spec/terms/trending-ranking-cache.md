---
id: trending-ranking-cache
title: Trending ranking cache
kind: term
status: draft
aliases: [cached ranking, ranking]
defined_for: S35-trending
rules_hash: 8fa35b4974e3
---
# Trending ranking cache
## Definition
The trending ranking cache is how long a ranked trending list can be reused before it is computed again. A `200` answer from [`GET /api/trending`](get-trending.md) carries a [public `Cache-Control` header ↗](../sw-external-terms.md#cache-control), so [shared caches ↗](../sw-external-terms.md#shared-cache) can serve it without asking the origin. Only the ranking is cached. [Product facts and visibility](search-visibility.md) are read again on every origin request, so a stock change shows at origin at once. Error answers are never cached.

## Example
```
GET /api/trending?category=audio&limit=20
200 OK
Cache-Control: public, max-age=30, s-maxage=30
```
If a ranked product sells out, the next origin request leaves it out right away. A shared cache may keep serving the older body until it expires.

## Known gaps
- The spec does not say whether the ranking is also cached inside the backend, or only by HTTP caches through `Cache-Control`.
- The spec does not say what identifies one cached ranking: the category alone, or the category and [`limit`](trending-limit.md) together.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-11
- [W02](../capabilities/W02-storefront-discovery.md): R-02
- [bounded-retention](bounded-retention.md)
- [catalog-category](catalog-category.md)
- [cold-request](cold-request.md)
- [dataset-t](dataset-t.md)
- [get-trending](get-trending.md)
- [rank-badge](rank-badge.md)
- [ranking-span](ranking-span.md)
- [search-visibility](search-visibility.md)
- [trending-window](trending-window.md)
- [unknown-query-parameter](unknown-query-parameter.md)
- [visitor](visitor.md)
<!-- used-by:end -->
