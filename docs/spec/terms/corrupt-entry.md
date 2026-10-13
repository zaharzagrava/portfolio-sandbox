---
id: corrupt-entry
title: Corrupt entry
kind: term
status: draft
aliases: [corrupt]
defined_for: cache-layers
rules_hash: 043540380d4d
---
# Corrupt entry
## Definition
A corrupt entry is a value in the cache that the [toolkit](cache-toolkit.md) cannot parse back into data. [`getOrLoad`](get-or-load.md) treats it as a [miss](cache-miss.md) with outcome `corrupt`: it calls the [loader](loader.md) and writes the fresh value over the bad one. The request does not fail. This is safe because every copy can be rebuilt from the database. Design intent (not stated in the spec): one bad entry should cost one extra load and should not break the request or stay in the cache.

## Example
S05 reads a product page from [L2](l2-cache.md), but the stored bytes are cut off (illustrative). The read is recorded with outcome `corrupt`, the product loader runs and the caller gets the fresh product. The new value replaces the broken entry in the cache.

## Known gaps
- The spec does not say whether "stored entry" means only L2 or also [L1](l1-cache.md).
- The spec does not say what counts as "unparseable", for example whether an entry in an old format version also counts as corrupt.
- The spec does not say whether the overwrite after a `corrupt` read also goes through [single-flight](single-flight.md) and the [recompute lock](recompute-lock.md). It should, since the read counts as a miss, but the spec does not state it.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-12, R-15
- [S52](../capabilities/S52-cache-toolkit.md): R-06
- [cache-layers](../concepts/cache-layers.md): C-08
- [cache-miss](cache-miss.md)
- [cache-toolkit](cache-toolkit.md)
- [l1-cache](l1-cache.md)
- [l2-cache](l2-cache.md)
- [loader](loader.md)
- [neighbour-score](neighbour-score.md)
- [recompute-lock](recompute-lock.md)
- [single-flight](single-flight.md)
<!-- used-by:end -->
