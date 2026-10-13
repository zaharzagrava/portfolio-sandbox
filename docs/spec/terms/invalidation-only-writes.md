---
id: invalidation-only-writes
title: Writers only delete (invalidation-only writes)
kind: term
status: draft
aliases: []
defined_for: cache-layers
rules_hash: cc6fcae86d59
---
# Writers only delete (invalidation-only writes)
## Definition
"Writers only delete" means that code which changes data never puts a new value into the cache. It can only remove the old [entry](cache-entry.md) with [`invalidate`](invalidate.md). The next reader [misses](cache-miss.md) and rebuilds the entry from the database through its [loader](loader.md). [The toolkit](cache-toolkit.md) enforces this by offering no method that stores a value supplied by the caller. The reason, design intent (not stated in the spec): the cache can never hold a value the database does not have, for example when two writers race.

## Example
After a shop changes a product's price, the [S05](../capabilities/S05-products.md) write path calls `invalidate` on that product's key. The next product-page read runs the loader and caches the new price.

## Known gaps
- The spec does not say whether `invalidate` must be called after the database commit or before it.
- The spec does not say how S05 invalidates its product cache.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-17
- [S28](../capabilities/S28-notifications.md): R-20
- [S52](../capabilities/S52-cache-toolkit.md): R-20
- [cache-layers](../concepts/cache-layers.md): C-07
- [authorization-cache](authorization-cache.md)
- [cache-entry](cache-entry.md)
- [cache-invalidator](cache-invalidator.md)
- [cache-miss](cache-miss.md)
- [cache-toolkit](cache-toolkit.md)
- [loader](loader.md)
<!-- used-by:end -->
