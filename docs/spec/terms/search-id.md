---
id: search-id
title: searchId
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: 81ca88de3a86
---
# searchId
## Definition
`searchId` is an identifier returned with every successful search response. S32's configuration includes a `searchId` [signing key ↗](../sw-external-terms.md#digital-signature), so the identifier is signed and clients cannot forge it. It most likely lets [`POST /search/clicks`](post-search-clicks.md) tie a click back to the search that showed the result. That link is what makes the per-query [click-through rate](click-through-rate.md) and [MRR](mrr.md) in [`GET /admin/search/quality`](get-admin-search-quality.md) possible. Both points are design intent (not stated in the spec).

## Example
```
GET /products/search?q=iphone
→ 200 { "items": [ ... ], "searchId": "<signed id>", ... }
```
The client later calls `POST /search/clicks` with that `searchId` and the clicked product, and gets `202`. (The click body shape is illustrative.)

## Known gaps
- The spec does not say the format of `searchId`, how long it stays valid, or what a click with a bad signature returns.
- The spec does not say the request body of `POST /search/clicks`, or whether `searchId` is required in it.
- Not confirmed in the code: whether `searchId` is carried in the [`search.performed`](search-performed-event.md) and `search.result_clicked` events.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-39
- [click-through-rate](click-through-rate.md)
- [mrr](mrr.md)
<!-- used-by:end -->
