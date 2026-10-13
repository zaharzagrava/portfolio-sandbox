---
id: redis-neighbour-lists-adapter
title: RedisNeighbourListsAdapter
kind: term
status: draft
aliases: []
defined_for: S34-recommendations
rules_hash: e3b0c44298fc
---
# RedisNeighbourListsAdapter
## Definition
`RedisNeighbourListsAdapter` is the infrastructure class that stores the bought-together [neighbour lists](neighbour-list.md) in Redis. Each product has one list, kept as a Redis [sorted set ↗](../sw-external-terms.md#redis-sorted-set) of neighbour product ids with their [neighbour scores](neighbour-score.md). When a bought-together build publishes a product's list, this adapter performs the [atomic list swap](atomic-list-swap.md). It also sets the list's [time-to-live ↗](../sw-external-terms.md#time-to-live), so a list that no build refreshes eventually disappears. Once a list is gone, the recommendations endpoint answers with an empty `items` array.

## Example
The nightly build `recommendations.build-bought-together` computes that product `M` has neighbours `C` (0.2067) and `P` (0.1794). `RedisNeighbourListsAdapter` replaces `M`'s sorted set as a whole and sets its 3-day TTL (S34.R-19). If no successful build rewrites it within 3 days, `GET /api/products/M/recommendations` returns `items: []`.

## Known gaps
- Not confirmed in the code: whether the endpoint also reads lists through this adapter. That includes the single list read and the batched read of the best direct neighbours for the [2-hop lookup](two-hop-lookup.md). The facts link this class only to the atomic replace and the TTL in S34.R-19.
- Not confirmed in the code: whether this adapter deletes the lists of products that have no edges left after a fully successful build (S34.R-20). S34.R-20 has no code link.
- Not confirmed in the code: how the swap is made atomic, for example with a transaction or by writing a temporary key and renaming it.

## Used by
<!-- used-by:start -->
- [atomic-list-swap](atomic-list-swap.md)
- [neighbour-list](neighbour-list.md)
- [neighbour-score](neighbour-score.md)
- [two-hop-lookup](two-hop-lookup.md)
<!-- used-by:end -->
