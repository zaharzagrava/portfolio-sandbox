---
id: hops
title: hops
kind: term
status: draft
aliases: [hop]
defined_for: S34-recommendations
rules_hash: 6e6bea55d744
---
# hops
## Definition
`hops` is a field on each recommended item that says how the item was found. `1` means it is a [direct neighbour](direct-neighbour.md) of the requested product. `2` means it was reached through a direct neighbour by the [2-hop lookup](two-hop-lookup.md). `hops` is the [first sort key](search-total-order.md), so every direct item comes before every indirect item, whatever the scores. The spec does not give a reason for this. Design intent (not stated in the spec): [direct co-purchases](bought-together.md) are stronger evidence than inferred ones.

## Example
For product `S` with one direct neighbour `K` (S34.B-06):
```json
{"items": [{"productId": "K", "score": 0.2046, "hops": 1},
           {"productId": "P", "score": 0.0673, "hops": 2}]}
```
(The JSON field layout is illustrative.)

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): B-01, B-06
- [bought-together](bought-together.md)
- [direct-neighbour](direct-neighbour.md)
- [product-id](product-id.md)
- [search-total-order](search-total-order.md)
- [two-hop-lookup](two-hop-lookup.md)
<!-- used-by:end -->
