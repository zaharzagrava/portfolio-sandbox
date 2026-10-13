---
id: negative-caching
title: Negative caching (negativeTtlMs)
kind: term
status: draft
aliases: [negative entries, negativettlms]
defined_for: cache-layers
rules_hash: d80e14c89561
---
# Negative caching (negativeTtlMs)
## Definition
Negative caching stores a `null` [loader](loader.md) result, meaning "this does not exist", so repeated lookups for a missing key skip the loader. It happens only when `negativeTtlMs` is set. Otherwise `null` is not stored. An `undefined` result is never cached in any case. Negative entries ignore [stale-while-revalidate](stale-while-revalidate.md) and are never served past expiry when a reload fails, so they simply expire.

## Example
A client keeps requesting a product id that does not exist. With an illustrative `negativeTtlMs: 5000`, the first lookup's `null` is cached and repeat lookups return `null` without touching the database. Once the entry expires, the next lookup calls the loader again.

## Known gaps
- The spec does not say how a negative entry is cleared when the missing item is created. C-07 only lets writers delete, so creating the item presumably needs an [`invalidate`](invalidate.md), but no rule says so.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-16
- [S52](../capabilities/S52-cache-toolkit.md): R-02, B-09
- [authorization-cache](authorization-cache.md)
- [cache-entry](cache-entry.md)
- [cache-toolkit](cache-toolkit.md)
- [loader](loader.md)
- [source-of-truth](source-of-truth.md)
- [stale-if-error](stale-if-error.md)
- [stale-while-revalidate](stale-while-revalidate.md)
<!-- used-by:end -->
