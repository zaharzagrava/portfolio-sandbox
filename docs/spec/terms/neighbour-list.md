---
id: neighbour-list
title: Neighbour list
kind: term
status: draft
aliases: [lists, neighbour lists]
defined_for: S34-recommendations
rules_hash: e3b0c44298fc
---
# Neighbour list
## Definition
A neighbour list is the stored, ranked list of products bought together with one product. Each product has one list, kept as a [Redis sorted set ↗](../sw-external-terms.md#redis-sorted-set). Each member is a neighbour's `productId`, and its value is the edge's [neighbour score](neighbour-score.md). The [bought-together build](order-baskets-build.md) writes these lists, and [`RedisNeighbourListsAdapter`](redis-neighbour-lists-adapter.md) reads them when the endpoint is called. Each list is replaced in one [atomic swap](atomic-list-swap.md) and has a time-to-live. When a list expires or is removed, the endpoint answers `items: []` for that product.

Each list keeps only a capped number of the best edges. It is ordered by score from highest to lowest, then by `productId` in ascending order. The ordering does not depend on the [bucket count](bucket-count.md). At read time, a stored entry is skipped and counted, without failing the request, if:
- its member is not a UUID,
- its member is the requested product itself, or
- its score is outside the allowed range.

Visibility is not stored in the list. It is checked on every origin request. A hidden neighbour stays in the list and can still act as a bridge for the [2-hop lookup](two-hop-lookup.md).

## Example
After dataset D is built, the list for product `M` holds `C` (0.2067) above `P` (0.1794). A request for `M` returns both items with `hops: 1`.

The list for `S` holds a single entry, `K` (0.2046). Because `S` has fewer direct neighbours than `limit`, the endpoint also reads `K`'s list. It then adds `P` with a score of 0.0673 and `hops: 2`.

## Known gaps
- The spec does not say the Redis key name used for a product's list.
- The spec does not say how the atomic replacement is done in Redis (for example, writing a temporary key and renaming it).

## Used by
<!-- used-by:start -->
- [atomic-list-swap](atomic-list-swap.md)
- [bucket-count](bucket-count.md)
- [build-lock](build-lock.md)
- [get-product-recommendations](get-product-recommendations.md)
- [neighbour-score](neighbour-score.md)
- [order-baskets-build](order-baskets-build.md)
- [recommendations-config](recommendations-config.md)
- [redis-neighbour-lists-adapter](redis-neighbour-lists-adapter.md)
- [two-hop-lookup](two-hop-lookup.md)
<!-- used-by:end -->
