---
id: l1-ttl-ms
title: l1TtlMs
kind: term
status: draft
aliases: []
defined_for: cache-layers
rules_hash: e3b0c44298fc
---
# l1TtlMs
## Definition
`l1TtlMs` is the setting that limits how long an [L1 cache](l1-cache.md) copy may live in one process. It has a default and an upper bound. After that time, the next read falls through to the [L2 cache](l2-cache.md) or the [loader](loader.md). A short limit keeps per-process copies close to the shared state when other instances [invalidate](invalidate.md). This reason is design intent (not stated in the spec).

## Example
With the default `l1TtlMs` of 1,000 ms, an instance may serve its own L1 copy for about one second at most. Callers can raise it, but never above 5,000 ms.

## Known gaps
- The spec does not say what happens when `l1TtlMs` is set above the maximum (clamped or rejected).
- The spec does not say whether the [`jitter`](jitter.md) setting also applies to `l1TtlMs`.

## Used by
<!-- used-by:start -->
- [invalidate](invalidate.md)
- [l1-cache](l1-cache.md)
- [l2-cache](l2-cache.md)
- [loader](loader.md)
<!-- used-by:end -->
