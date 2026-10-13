---
id: invalidate
title: invalidate
kind: term
status: draft
aliases: []
defined_for: cache-layers
rules_hash: 09ae9c3a381f
---
# invalidate
## Definition
`invalidate` is the [cache toolkit](cache-toolkit.md)'s only write-side operation. It deletes a key's [entry](cache-entry.md) from [L2](l2-cache.md) and evicts the copy in the local [L1](l1-cache.md). It never throws when the shared store fails. Instead it resolves with a result that reports the failure, and it still evicts the local L1 copy.

## Example
```ts
const result = await cache.invalidate(productKey); // names illustrative
// if L2 is unreachable: { l2: 'failed', deleted: 0 }
```

## Known gaps
- The spec does not say how L1 copies in other processes are cleared. They may keep serving the old value until [`l1TtlMs`](l1-ttl-ms.md) runs out.
- The spec does not say what result `invalidate` returns on success.
- The spec does not say whether the caller should retry after an [`l2: 'failed'`](invalidate-result.md) result.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-18
- [S52](../capabilities/S52-cache-toolkit.md): B-11
- [cache-entry](cache-entry.md)
- [cache-toolkit](cache-toolkit.md)
- [catalog-product-updated-event](catalog-product-updated-event.md)
- [l1-cache](l1-cache.md)
- [l1-ttl-ms](l1-ttl-ms.md)
- [l2-cache](l2-cache.md)
- [version-conflict](version-conflict.md)
<!-- used-by:end -->
