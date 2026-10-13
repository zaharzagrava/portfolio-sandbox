---
id: recommendations-unavailable
title: recommendations_unavailable (503)
kind: term
status: draft
aliases: [recommendations_unavailable]
defined_for: S34-recommendations
rules_hash: e3b0c44298fc
---
# recommendations_unavailable (503)
## Definition
`recommendations_unavailable` is the error code the [bought-together endpoint](bought-together.md) returns with status `503` when it cannot build a safe answer. It is raised when the [neighbour list store](direct-neighbour.md), the product lookup or the shop lookup fails or runs past its [time budget](page-deadline.md). The endpoint never falls back to an unfiltered list, because without the lookups it cannot hide inactive, sandbox or out-of-stock products. The answer carries a [`Retry-After` header ↗](../sw-external-terms.md#retry-after) and is [never cached ↗](../sw-external-terms.md#cache-control-no-store). In code it is `RecommendationsUnavailableError`.

## Example
The product lookup for `GET /api/products/M/recommendations` takes longer than its budget, so the caller gets:
```
HTTP/1.1 503
Retry-After: 5
Cache-Control: no-store
code: recommendations_unavailable
```

## Known gaps
- The spec does not say whether a failure inside the [2-hop batch read](two-hop-lookup.md) counts as a list store failure that leads to this `503`.
- The spec does not say why a `503` is preferred over an empty `items: []` list. Keeping callers from caching a false "no neighbours" answer is design intent (not stated in the spec).

## Used by
<!-- used-by:start -->
- [bought-together](bought-together.md)
- [direct-neighbour](direct-neighbour.md)
- [page-deadline](page-deadline.md)
- [two-hop-lookup](two-hop-lookup.md)
<!-- used-by:end -->
