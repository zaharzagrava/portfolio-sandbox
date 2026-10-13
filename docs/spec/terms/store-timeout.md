---
id: store-timeout
title: Store attempt timeout
kind: term
status: draft
aliases: [store timeout]
defined_for: S52-cache-toolkit
rules_hash: 4ee166aab490
---
# Store attempt timeout
## Definition
The store attempt timeout limits how long [`getOrLoad`](get-or-load.md) waits for the [shared store (L2)](l2-cache.md) before giving up on it. When the timeout fires, the read does not fail. It goes on to the [loader](loader.md), which answers the caller. A store that hangs therefore slows reads down but cannot block them indefinitely.

## Example
The shared store accepts connections but never answers. A `getOrLoad` call stops waiting for the store after 250 ms, calls the loader, and returns the loader's value.

## Known gaps
- The spec does not say whether this timeout can be configured.
- The spec does not say whether it also applies to [`invalidate`](invalidate.md), to the [Bloom filter ↗](../sw-external-terms.md#bloom-filter) or to `DistributedLock` calls.
- The spec does not say whether a timeout counts as a failure for the [cache store circuit breaker](cache-store-circuit-breaker.md), or which outcome it is counted under.

## Used by
<!-- used-by:start -->
- [S52](../capabilities/S52-cache-toolkit.md): B-16
- [cache-store-circuit-breaker](cache-store-circuit-breaker.md)
- [l2-cache](l2-cache.md)
- [loader](loader.md)
<!-- used-by:end -->
