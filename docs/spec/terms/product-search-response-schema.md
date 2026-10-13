---
id: product-search-response-schema
title: productSearchResponseSchema
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# productSearchResponseSchema
## Definition
`productSearchResponseSchema` is the shared contract that every product search response must match. A response that does not parse with it breaks a rule of [S32](../capabilities/S32-product-search.md). It sets the response shape that clients rely on, such as the [search items](search-items.md), the [`nextCursor`](pagination-cursor.md), the [`searchId`](search-id.md) and the [`mode`](search-mode.md). The same rule also requires that the response carry `Cache-Control: private, no-store`.

## Example
An anonymous `GET /products/search?q=iphone` answers `200` with a body that parses with the schema. Field values below are illustrative:
```json
{ "mode": "...", "items": [ { "id": "p1", "sponsored": false, "imageUrl": "..." } ], "nextCursor": null, "searchId": "..." }
```

## Known gaps
- Not confirmed in the code: the only code reference on this rule points to `productSearchQuerySchema` in `packages/contracts/src/search/product-search.ts`. That is the query schema, not the response schema, so where the response schema lives has not been verified.
- The spec does not say the full field list of the response, such as how totals or facets appear in it.

## Used by
<!-- used-by:start -->
- [search-items](search-items.md)
<!-- used-by:end -->
