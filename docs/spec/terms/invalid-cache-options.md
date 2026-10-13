---
id: invalid-cache-options
title: InvalidCacheOptions
kind: term
status: draft
aliases: []
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# InvalidCacheOptions
## Definition
`InvalidCacheOptions` is the error raised when an option passed to the [toolkit](cache-toolkit.md) is outside its allowed range. Examples are [`l1TtlMs`](l1-ttl-ms.md), [`jitter`](jitter.md) and [`maxEntryBytes`](max-entry-bytes.md). The error names the bad field. It is raised before any call to the [shared store](l2-cache.md), so a bad configuration never touches [L1](l1-cache.md) or L2. Design intent (not stated in the spec): it fails early and loudly, so a misconfigured caller is found in testing and not as odd cache behaviour in production.

## Example
```ts
await cache.getOrLoad(key, loader, { ttlMs: 60000, l1: 'always', l1TtlMs: 6000 });
// throws InvalidCacheOptions naming `l1TtlMs` (above its allowed maximum); no store call is made
```

## Known gaps
- The spec does not say whether it is thrown synchronously or returned as a rejected promise.
- The spec does not say whether methods other than [`getOrLoad`](get-or-load.md) (such as `getOrLoadMany` or [`invalidateIfOlder`](invalidate-if-older.md)) validate their options the same way. The code reference is `resolveGetOrLoadOptions`.
- The spec does not give the error's exact shape, meaning how the field name is exposed to the caller.

## Used by
<!-- used-by:start -->
- [cache-toolkit](cache-toolkit.md)
- [l1-cache](l1-cache.md)
- [l2-cache](l2-cache.md)
<!-- used-by:end -->
