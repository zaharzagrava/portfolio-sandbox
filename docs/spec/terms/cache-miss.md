---
id: cache-miss
title: Cache miss and outcomes
kind: term
status: draft
aliases: [outcome]
defined_for: cache-layers
rules_hash: 2e222093b3df
---
# Cache miss and outcomes
## Definition
A cache miss happens when `[getOrLoad](get-or-load.md)` finds no usable value in [L1](l1-cache.md) or [L2](l2-cache.md) and has to call the [loader](loader.md). Each read ends with an outcome, a label for how the read finished; `corrupt` is the only outcome the facts name. When several requests miss on the same key at the same time, they share one loader call through [single-flight](single-flight.md). A loader error or an `undefined` result is never cached, so the next read misses again.

## Example
Two requests for the same product page arrive in one S05 process while the key is in neither L1 nor L2. Both requests wait on one loader call and get the same result. If the loader rejects, both requests get the same error, and the error is not cached.

## Known gaps
- The spec does not list the outcomes besides `corrupt`, for example hit, stale or negative.
- The spec does not say where outcomes are reported (metrics, logs or the return value).
- The spec does not say whether a read that returns a stale value inside `swrMs` or `staleIfErrorMs` counts as a miss or as a hit.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): B-08
- [S52](../capabilities/S52-cache-toolkit.md): R-06, R-07, R-12, B-05, B-08
- [cache-layers](../concepts/cache-layers.md): C-08
- [consumer-outcomes](consumer-outcomes.md)
- [corrupt-entry](corrupt-entry.md)
- [get-or-load](get-or-load.md)
- [invalidation-only-writes](invalidation-only-writes.md)
- [l1-cache](l1-cache.md)
- [l2-cache](l2-cache.md)
- [loader](loader.md)
- [no-op-update](no-op-update.md)
- [single-flight](single-flight.md)
- [source-of-truth](source-of-truth.md)
<!-- used-by:end -->
