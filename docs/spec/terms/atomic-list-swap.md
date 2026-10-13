---
id: atomic-list-swap
title: Atomic list swap
kind: term
status: draft
aliases: [full old or full new list]
defined_for: S34-recommendations
rules_hash: cfaff3be9ec1
---
# Atomic list swap
## Definition
An atomic list swap is how the [build](order-baskets-build.md) replaces one product's [neighbour list](direct-neighbour.md) in Redis. The list is replaced as a whole, so a reader never sees a list that is half written. Every request made during a build gets either the complete old list or the complete new one. The swap also sets the list's [time-to-live ↗](../sw-external-terms.md#time-to-live).

## Example
50 callers request `GET /api/products/M/recommendations` while a build rewrites `M`'s list. Each response contains either the full old ranking or the full new ranking, never a mix of the two (S34.B-17). This is implemented in `[RedisNeighbourListsAdapter](redis-neighbour-lists-adapter.md)`.

## Known gaps
- Not confirmed in the code: the mechanism that makes the swap atomic, for example a transaction or a [write-then-rename ↗](../sw-external-terms.md#atomicity).
- The spec does not say whether different lists are swapped together. Each list is atomic on its own, so a [2-hop request](two-hop-lookup.md) that reads several lists during a build could mix old and new lists.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): B-17
- [direct-neighbour](direct-neighbour.md)
- [neighbour-list](neighbour-list.md)
- [order-baskets-build](order-baskets-build.md)
- [redis-neighbour-lists-adapter](redis-neighbour-lists-adapter.md)
- [two-hop-lookup](two-hop-lookup.md)
<!-- used-by:end -->
