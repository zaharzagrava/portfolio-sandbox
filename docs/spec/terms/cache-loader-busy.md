---
id: cache-loader-busy
title: CacheLoaderBusy
kind: term
status: draft
aliases: []
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# CacheLoaderBusy
## Definition
`CacheLoaderBusy` is the error a cache read rejects with when it waited too long for a free slot under the [loader concurrency limit](loader-concurrency-limit.md). The caller gets no value, neither [stale](stale-if-error.md) nor loaded. Its job is to [shed load](load-shedding.md) so the database is not overwhelmed while the [shared store](l2-cache.md) is unavailable.

## Example
With the store down and 500 distinct keys read at once, 100 loaders run. A caller still waiting for a slot after 2 s rejects with `CacheLoaderBusy`.

## Known gaps
- The spec does not say how `CacheLoaderBusy` maps to an HTTP status or error code, or whether callers should retry.
- The spec does not say whether [`staleIfErrorMs`](stale-if-error.md) can turn this rejection into a stale answer.

## Used by
<!-- used-by:start -->
- [l2-cache](l2-cache.md)
- [load-shedding](load-shedding.md)
- [loader-concurrency-limit](loader-concurrency-limit.md)
- [stale-if-error](stale-if-error.md)
<!-- used-by:end -->
