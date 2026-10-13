---
id: max-entry-bytes
title: maxEntryBytes
kind: term
status: draft
aliases: []
defined_for: cache-layers
rules_hash: e3b0c44298fc
---
# maxEntryBytes
## Definition
`maxEntryBytes` is the size ceiling for a single [cached entry](cache-entry.md) in the [cache toolkit](cache-toolkit.md). If a loaded value is bigger than this ceiling, the caller still gets the value, but it is not stored in [L1](l1-cache.md) or [L2](l2-cache.md). Every later read of that key therefore goes back to the [loader](loader.md). The rule sets both a default and a hard maximum.

## Example
A product-page aggregate loaded through `getOrLoad` turns out to be 300 KiB (illustrative). With the default `maxEntryBytes` of 256 KiB, the caller receives the aggregate, but neither L1 nor L2 keeps a copy.

## Known gaps
- The spec does not say how size is measured, for example whether it is the serialized bytes or the in-memory size.
- The spec does not say whether skipping an oversized entry is logged or reported as an outcome, so a key that is always too big may go unnoticed.
- The spec does not say whether `maxEntryBytes` is set per key, per call or once for the whole toolkit.

## Used by
<!-- used-by:start -->
- [cache-entry](cache-entry.md)
- [cache-toolkit](cache-toolkit.md)
- [l1-cache](l1-cache.md)
- [l2-cache](l2-cache.md)
- [loader](loader.md)
<!-- used-by:end -->
