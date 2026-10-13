---
id: soft-expiry
title: Soft expiry
kind: term
status: draft
aliases: [exp]
defined_for: cache-layers
rules_hash: d1cb46d082c9
---
# Soft expiry
## Definition
Soft expiry is the point after which a [cache entry](cache-entry.md) counts as [stale](stale-while-revalidate.md) but may still be served. Between soft expiry and the end of the [`swrMs`](stale-while-revalidate.md) window, the entry is returned at once and refreshed in the background. Lifetimes are [jittered](jitter.md), so entries written together do not all go stale at the same moment.

## Example
An entry is written with an illustrative lifetime of 60 s and `swrMs` of 30 s. A read at 70 s is past soft expiry but inside the window. It returns the cached value immediately and starts one background refresh.

## Known gaps
- The spec does not say whether `exp` (used in the [stale-if-error rule](stale-if-error.md)) is the soft expiry or some other, hard expiry.
- The spec does not say how soft expiry relates to XFetch, which S52 lists as part of the toolkit.

## Used by
<!-- used-by:start -->
- [S52](../capabilities/S52-cache-toolkit.md): R-12
- [cache-layers](../concepts/cache-layers.md): C-04
- [cache-entry](cache-entry.md)
- [jitter](jitter.md)
- [stale-if-error](stale-if-error.md)
- [stale-while-revalidate](stale-while-revalidate.md)
- [xfetch](xfetch.md)
<!-- used-by:end -->
