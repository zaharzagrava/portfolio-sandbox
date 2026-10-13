---
id: invalidate-result
title: invalidate result
kind: term
status: draft
aliases: [l2: 'failed']
defined_for: cache-layers
rules_hash: e3b0c44298fc
---
# invalidate result
## Definition
The invalidate result is the object that [`invalidate`](invalidate.md) resolves with, so the caller can see what happened in [L2](l2-cache.md). When the [shared store](l2-cache.md) fails, the result says `l2: 'failed'` and reports that nothing was deleted, and the call does not throw. The caller must check this result, because a failed L2 delete means other readers can still get the old value.

## Example
```json
{ "l2": "failed", "deleted": 0 }
```

## Known gaps
- The spec does not say what other values `l2` can take or what `deleted` counts on success.
- The spec does not say what a caller should do after `l2: 'failed'`, such as retry, raise an alert or ignore it.

## Used by
<!-- used-by:start -->
- [l2-cache](l2-cache.md)
<!-- used-by:end -->
