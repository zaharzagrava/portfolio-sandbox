---
id: product-id
title: productId
kind: term
status: draft
aliases: []
defined_for: S34-recommendations
rules_hash: e3b0c44298fc
---
# productId
## Definition
`productId` is the UUID that identifies one product. It appears in the endpoint path as the product the caller wants a [rail](recommendation-rail.md) for. It is also the last tie-break when items are ranked: items with the same [hop](hops.md) and [score](neighbour-score.md) are sorted by `productId` ascending. A value that is not a UUID is rejected with [`validation_failed`](validation-failed-error.md), which names the field.

## Example
`GET /api/products/not-a-uuid/recommendations` answers `400` `validation_failed`, with the field named in [`errors`](errors-entry.md) (for example `errors: [{field: "productId"}]`, modelled on S34.B-03).

## Known gaps
- The spec does not say what the full response item looks like. It only implies that each item carries a `productId`, because the ranking sorts by it.

## Used by
<!-- used-by:start -->
- [hops](hops.md)
- [neighbour-score](neighbour-score.md)
- [recommendation-rail](recommendation-rail.md)
<!-- used-by:end -->
