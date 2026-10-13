---
id: trending-unavailable
title: trending_unavailable (503)
kind: term
status: draft
aliases: [trending_unavailable]
defined_for: S35-trending
rules_hash: e3b0c44298fc
---
# trending_unavailable (503)
## Definition
`trending_unavailable` is the error code that [`GET /api/trending`](get-trending.md) returns with status `503`. It is returned when the [aggregate store](trending-aggregate.md), the product lookup or the shop lookup fails or runs over its [budget](page-deadline.md). The answer carries [`Retry-After` ↗](../sw-external-terms.md#retry-after) and [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store), so it is never cached. In code it is `TrendingUnavailableError`.

## Example
The shop lookup takes longer than its 50 ms budget:
```
503 Service Unavailable
Retry-After: 5
Cache-Control: no-store
```
The body carries the code `trending_unavailable`.

## Known gaps
- The spec does not say in detail how the home page "Trending now" rail or the product-page composition handle this `503`. AS-41 and AS-42 are tested, but no rule states it.

## Used by
<!-- used-by:start -->
- [page-deadline](page-deadline.md)
- [trending-aggregate](trending-aggregate.md)
<!-- used-by:end -->
