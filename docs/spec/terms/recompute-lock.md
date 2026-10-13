---
id: recompute-lock
title: Per-key recompute lock
kind: term
status: draft
aliases: [recompute lock]
defined_for: cache-layers
rules_hash: 81a8cb740600
---
# Per-key recompute lock
## Definition
The per-key recompute lock is a short-lived lock shared across instances. The process holding it is the one that rebuilds a missing or expired cache key. It extends [single-flight](single-flight.md) beyond one process: within a process, concurrent misses already share one [loader call](loader.md), and the lock makes sure only one process recomputes. The lock has a fixed lifetime set in the rules, so a crashed holder cannot block the key forever.

## Example
Instances A and B of the [S05 product service](../capabilities/S05-products.md) both miss the key for one product at the same moment. A gets the recompute lock and runs the loader. B does not run its own loader for that key. The lock expires by itself after its 5 s lifetime.

## Known gaps
- The spec does not say what a process that fails to get the lock does: wait, retry, serve stale, or fall through to the loader.
- The spec does not say what happens when a loader runs longer than the lock lifetime. A second process could then take the lock and recompute at the same time.
- The spec does not say which store holds the lock. [S52](../capabilities/S52-cache-toolkit.md) lists a "[distributed lock ↗](../sw-external-terms.md#distributed-lock)" in the toolkit but does not name its backend.

## Used by
<!-- used-by:start -->
- [S52](../capabilities/S52-cache-toolkit.md): R-11, B-06, B-20
- [cache-layers](../concepts/cache-layers.md): C-03
- [corrupt-entry](corrupt-entry.md)
- [distributed-lock-try-acquire](distributed-lock-try-acquire.md)
- [l2-cache](l2-cache.md)
- [loader](loader.md)
- [lock-unavailable](lock-unavailable.md)
- [single-flight](single-flight.md)
- [xfetch](xfetch.md)
<!-- used-by:end -->
