---
id: invalid-loader-result
title: InvalidLoaderResult
kind: term
status: draft
aliases: []
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# InvalidLoaderResult
## Definition
`InvalidLoaderResult` is the error that [`getOrLoad`](get-or-load.md) rejects with when your [loader](loader.md) returns `undefined`. Use `null` to say "not found". The [toolkit](cache-toolkit.md) treats `undefined` as a bug in the loader, not as an answer. When this happens, nothing is stored in [L1 or L2](l1-cache.md). The error is not cached, so the next read calls the loader again.

## Example
```ts
// key built with cacheKey('product', 1, productId); 'product' and 1 are illustrative
await cache.getOrLoad(key, async () => undefined, { ttlMs: 60000 }); // rejects with InvalidLoaderResult
await cache.getOrLoad(key, async () => null,      { ttlMs: 60000 }); // resolves null ("not found")
```

## Known gaps
- The spec does not say whether other values that are not JSON also reject with `InvalidLoaderResult`. The check sits in `entry-codec.ts#assertJsonValue`, but the spec only names `undefined`.
- The spec does not say whether [`staleIfErrorMs`](stale-if-error.md) counts this rejection as a loader error. If it does, a stale value could be returned in place of this error.
- The spec does not say whether `getOrLoadMany` applies the same check to each item a batch loader returns.

## Used by
<!-- used-by:start -->
- [cache-toolkit](cache-toolkit.md)
- [l1-cache](l1-cache.md)
- [loader](loader.md)
<!-- used-by:end -->
