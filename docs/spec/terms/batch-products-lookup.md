---
id: batch-products-lookup
title: Batch products lookup (GET /batch/products)
kind: term
status: draft
aliases: [/batch/products]
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# Batch products lookup (GET /batch/products)
## Definition
`GET /batch/products?ids=` is a read endpoint that returns the [public view](member-view.md) of several products in one call. [The BFF ↗](../sw-external-terms.md#bff) uses it. The response array keeps the order of the request. A product that is not [publicly visible](search-visibility.md) gets `null` in its position, so the caller cannot tell an invisible product from an unknown one. `ProductBatchReadController` implements it.

## Example
`b` is [archived](product-archive.md), and `a` and `c` are visible:
```
GET /batch/products?ids=a,b,c
→ [ { ...public view of a }, null, { ...public view of c } ]
```

## Known gaps
- The spec does not say how many IDs one call accepts, or what happens above that number.
- The spec does not say what credentials the endpoint requires. It also does not say which [rate limit policy](rate-limit-policy.md) applies.
- The spec does not say what happens to a malformed ID in the list (a `400` for the whole call, or `null`). It also does not say whether the endpoint reads through the product cache.

## Used by
<!-- used-by:start -->
- [member-view](member-view.md)
- [product-archive](product-archive.md)
- [rate-limit-policy](rate-limit-policy.md)
- [search-visibility](search-visibility.md)
<!-- used-by:end -->
