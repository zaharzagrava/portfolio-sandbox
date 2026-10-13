---
id: hot-key
title: Hot key
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: 89475305be4a
---
# Hot key
## Definition
A hot key is one cache key that receives far more reads than the others, for example the entry of one very popular product. In [S05](../capabilities/S05-products.md), product reads go through [layered caches](l1-cache.md), so a hot key concentrates load on a single [cache entry](cache-entry.md). When that entry is cold or expires, many requests can reach the database for it together. S05 limits this with [single-flight loading](single-flight.md) and [stale-while-revalidate](stale-while-revalidate.md), so one load or one background refresh serves all waiting readers. S05 lists acceptance scenario [AS-36](acceptance-scenario.md) for hot-key behavior.

## Example
A popular product's public page, `GET /products/:productId`, gets 100 concurrent reads while its cache entry is cold. Under `S05.B-09`, the database receives one statement and every reader shares the result. After the entry's fresh lifetime ends, readers get the stale entry while one background refresh runs (`S05.R-15`).

## Known gaps
- The spec does not say what AS-36 requires. The Known gaps entry "AS-36 hot key as listed in the code excerpts beyond cache tests" does not make clear which parts have a test and which do not.
- The spec does not say what makes a key "hot": no threshold, metric or detection is described.
- The spec does not say whether hot keys get any special handling beyond the general cache rules, such as a per-process L1 copy or early refresh.

## Used by
<!-- used-by:start -->
- [S52](../capabilities/S52-cache-toolkit.md): B-03
- [acceptance-scenario](acceptance-scenario.md)
- [cache-entry](cache-entry.md)
- [known-gaps](known-gaps.md)
- [l1-cache](l1-cache.md)
- [single-flight](single-flight.md)
- [stale-while-revalidate](stale-while-revalidate.md)
<!-- used-by:end -->
