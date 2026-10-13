---
id: invalidate-if-older
title: invalidateIfOlder
kind: term
status: draft
aliases: []
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# invalidateIfOlder
## Definition
`invalidateIfOlder(key, version, options)` is a delete that only takes effect when it carries a newer version. If the version is newer than any version already recorded for the key, it deletes the entry and records that version as the key's minimum in `{key}:min`. It then returns `applied`. Otherwise it does nothing and returns `skipped`. Afterwards, a reader that loaded an older version still gets its value, but the toolkit refuses to store it. This stops a slow reader from bringing old data back.

## Example
```ts
// K is cached at version 3
await cache.invalidateIfOlder(K, 4); // 'applied': the entry is gone, the minimum is 4
await cache.invalidateIfOlder(K, 4); // 'skipped' (repeat)
// after version 5 is recorded, a late invalidateIfOlder(K, 4) → 'skipped'
```

## Known gaps
- The spec does not say what `options` accepts, or how long the recorded minimum lives. The facts only call it "time-bounded".
- The spec does not say whether `invalidateIfOlder` also broadcasts on `cache:invalidate` to drop L1 copies, as `invalidate` does.
- The spec does not say what it returns or throws when the shared store is down. For `invalidate`, the documented result is `{l2: 'failed', deleted: 0}`.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
