---
id: window-minutes
title: windowMinutes
kind: term
status: draft
aliases: []
defined_for: S35-trending
rules_hash: e3b0c44298fc
---
# windowMinutes
## Definition
`windowMinutes` is a member of the [trending endpoint's `200` answer](get-trending.md). It gives the length of the [ranking span](ranking-span.md) in minutes, which is the stretch of time the trending scores cover. It is a fixed fact of the ranking and does not change with `category` or `limit`. A client can read it to label the [rail](recommendation-rail.md), for example "last hour", instead of hard-coding the span. That reason is design intent (not stated in the spec).

## Example
`GET /api/trending?category=audio&limit=2` with [dataset T](dataset-t.md) merged (S35.B-01). The product IDs and scores below are illustrative:
```json
{ "windowMinutes": 60, "items": [ { "productId": "p-101", "score": 42 }, { "productId": "p-205", "score": 17 } ] }
```

## Known gaps
- The spec does not say whether `windowMinutes` is read from the [`TRENDING_*` configuration](trending-configuration.md) or fixed in the response contract. The window setting there is the length of one window, not of the span.
- The spec does not say whether `windowMinutes` appears in the empty answer for a category without data (S35.B-05).
- The spec does not give the complete list of members in the answer or in each item, beyond `windowMinutes`, `items`, the score and the catalog category.

## Used by
<!-- used-by:start -->
- [dataset-t](dataset-t.md)
- [get-trending](get-trending.md)
- [ranking-span](ranking-span.md)
- [recommendation-rail](recommendation-rail.md)
- [trending-configuration](trending-configuration.md)
<!-- used-by:end -->
