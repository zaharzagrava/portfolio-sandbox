---
id: all-bucket
title: The all bucket
kind: term
status: draft
aliases: [all]
defined_for: S35-trending
rules_hash: e3b0c44298fc
---
# The all bucket
## Definition
`all` is the ranking across every category. It is the default value of the [`category` parameter](category-tracking.md), so leaving the parameter out gives the same answer as `category=all`. Each item in it still shows its [catalog category](catalog-category.md). Events from categories over the [category-tracking cap](category-tracking.md) count only here.

## Example
[`GET /api/trending`](get-trending.md) and `GET /api/trending?category=all` return identical bodies. An item in either one might look like this (values illustrative):
```json
{ "productId": "…", "category": "audio", "score": 35 }
```

## Known gaps
- The spec does not say what happens if a real catalog category is named `all`.
- The spec does not give the exact member names of an item, so the JSON above is illustrative.

## Used by
<!-- used-by:start -->
- [catalog-category](catalog-category.md)
- [category-tracking](category-tracking.md)
<!-- used-by:end -->
