---
id: single-flight
title: Single-flight (miss coalescing)
kind: term
status: draft
aliases: [share one loader call]
defined_for: cache-layers
rules_hash: f59d3ce43060
---
# Single-flight (miss coalescing)
## Definition
Single-flight is how the [cache toolkit](cache-toolkit.md) keeps a [loader](loader.md) from running many times when many requests miss the same key together. Inside a process, all concurrent misses for a key wait on the same loader call. They all get its result, and if it rejects, they all get the same rejection. Across instances, a shared lock held for each key does the same job, so only one process rebuilds the value.

## Example
Suppose 50 requests (illustrative) for the same product page reach S05 just after the [cached entry](cache-entry.md) expires. They all call [`getOrLoad`](get-or-load.md) for that key. The loader queries the database once, and all 50 callers get that one result. If the database call fails, all 50 get the same error, and C-01 says the error is not cached.

## Known gaps
- The spec does not say what other instances do while one process holds the recompute lock: wait, serve a stale value, or call the loader anyway.

## Used by
<!-- used-by:start -->
- [cache-layers](../concepts/cache-layers.md): C-03
- [cache-entry](cache-entry.md)
- [cache-miss](cache-miss.md)
- [cache-toolkit](cache-toolkit.md)
- [corrupt-entry](corrupt-entry.md)
- [get-or-load](get-or-load.md)
- [hot-key](hot-key.md)
- [loader](loader.md)
- [recompute-lock](recompute-lock.md)
- [xfetch](xfetch.md)
<!-- used-by:end -->
