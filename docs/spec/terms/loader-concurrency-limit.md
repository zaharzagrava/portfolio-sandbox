---
id: loader-concurrency-limit
title: Loader concurrency limit
kind: term
status: draft
aliases: [loaders run at once]
defined_for: S52-cache-toolkit
rules_hash: 83327520fc54
---
# Loader concurrency limit
## Definition
The loader concurrency limit is a [bulkhead ↗](../sw-external-terms.md#bulkhead): a cap on how many [loaders](loader.md) [the toolkit](cache-toolkit.md) runs at the same time. Extra calls wait for a free slot. A caller that waits too long rejects with [`CacheLoaderBusy`](cache-loader-busy.md). [The Decisions](decisions.md) give its purpose: to protect the database when [the store is down](l2-cache.md) and every read falls through to the loader.

## Example
The store is down and 500 reads of distinct keys arrive. At most 100 loaders run at once. Callers still waiting after 2 s reject with `CacheLoaderBusy`.

## Known gaps
- The spec does not say whether the limit is per process or applies to the whole fleet.
- The spec does not say whether the limit also applies when the store is healthy. The only scenario describes the store being down.
- The spec does not say whether the cap or the wait time can be configured.

## Used by
<!-- used-by:start -->
- [S52](../capabilities/S52-cache-toolkit.md): B-18
- [cache-loader-busy](cache-loader-busy.md)
- [cache-toolkit](cache-toolkit.md)
- [decisions](decisions.md)
- [l2-cache](l2-cache.md)
- [loader](loader.md)
<!-- used-by:end -->
