---
id: minimum-version
title: Minimum version
kind: term
status: draft
aliases: []
defined_for: S52-cache-toolkit
rules_hash: cd70a109e1b0
---
# Minimum version
## Definition
The minimum version is the lowest version of a key's value that the cache will still accept for storage. [`invalidateIfOlder`](invalidate-if-older.md) records it in an auxiliary `{key}:min` record next to the [cache entry](cache-entry.md). Later, a loaded value whose version is below the minimum is not stored, but the caller still receives it. This stops a [slow reader](loader.md) from putting old data back into the cache after a newer write.

## Example
Key `K` holds version 3. A writer commits version 4 and calls `invalidateIfOlder(K, 4)`. The result is [`applied`](invalidate-result.md), the entry is deleted and the minimum becomes 4.
A reader that loaded version 3 before the commit returns version 3 to its caller but stores nothing. Calling `invalidateIfOlder(K, 4)` again, or calling it late after version 5, returns [`skipped`](invalidate-result.md).

## Known gaps
- The spec does not say how long the minimum version record lives. The Decisions only call it "time-bounded".
- The spec does not say what happens when a loaded value carries no version. The entry's version field is optional.

## Used by
<!-- used-by:start -->
- [S52](../capabilities/S52-cache-toolkit.md): B-13
- [cache-entry](cache-entry.md)
- [loader](loader.md)
<!-- used-by:end -->
