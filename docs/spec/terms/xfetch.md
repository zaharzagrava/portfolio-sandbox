---
id: xfetch
title: XFetch (probabilistic early refresh)
kind: term
status: draft
aliases: [xfetch]
defined_for: cache-layers
rules_hash: d85ead790925
---
# XFetch (probabilistic early refresh)
## Definition
XFetch is a technique for refreshing a [cache entry](cache-entry.md) early, before its [soft expiry](soft-expiry.md), so that every reader doesn't miss at the same moment. In the standard XFetch algorithm, any read before expiry may trigger a refresh, and the chance of one rises as expiry gets closer and is higher for keys that take longer to rebuild. Design intent (not stated in the spec): it spreads refreshes over time, so one popular key expiring doesn't set off a burst of [loader calls](loader.md) all at once. [Single-flight](single-flight.md) and the [recompute lock](recompute-lock.md) handle the moment of a miss, while XFetch tries to avoid the miss entirely.

## Example
Illustrative only, not confirmed for any capability: a product entry served through `getOrLoad` takes 200 ms to rebuild and expires in 30 s. Most reads return it straight from the cache. As expiry gets closer, one read becomes more and more likely to call the loader early and store a fresh copy. If that happens, the other readers never see a miss.

## Known gaps
- The spec does not say how XFetch is turned on or tuned in this toolkit: the parameter names, their defaults and whether it is on by default.
- The spec does not say how XFetch works with stale-while-revalidate, jitter or the recompute lock. For example, it doesn't say whether an early refresh must first take the per-key recompute lock.
- The spec does not say which capabilities use XFetch. The cache page lists it only as part of S52's toolkit.

## Used by
<!-- used-by:start -->
- [S52](../capabilities/S52-cache-toolkit.md): R-14
- [cache-entry](cache-entry.md)
- [cache-toolkit](cache-toolkit.md)
- [loader](loader.md)
- [recompute-lock](recompute-lock.md)
- [single-flight](single-flight.md)
- [soft-expiry](soft-expiry.md)
<!-- used-by:end -->
